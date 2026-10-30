const { resolveAccount } = require('./crm-resolve');
const NIMBLE_BASE='https://api.nimble.com/api/v1';
async function fetchPage(token,page,perPage){ const url=`${NIMBLE_BASE}/contacts?record_type=company&per_page=${perPage}&page=${page}`; const res=await fetch(url,{headers:{Authorization:`Bearer ${token}`}}); if(res.status===401||res.status===403){const b=await res.text().catch(()=> '');throw new Error(`Nimble auth failed (${res.status}). ${b.slice(0,200)}`);} if(!res.ok)throw new Error(`Nimble returned ${res.status} for page ${page}.`); return res.json(); }
function nameOf(c){const f=c.fields||{};const pick=k=>Array.isArray(f[k])&&f[k][0]?(f[k][0].value||f[k][0]):null;return pick('company name')||pick('name')||c.name||c.display_name||'(unnamed)';}
function ownerNameOf(c){
  // best-effort: Nimble may expose the owner as a name in a few shapes
  if(c.owner&&typeof c.owner==='object'){ return c.owner.name||c.owner.display_name||((c.owner.first_name||'')+' '+(c.owner.last_name||'')).trim()||''; }
  if(typeof c.owner==='string') return c.owner;
  const f=c.fields||{}; const pick=k=>Array.isArray(f[k])&&f[k][0]?(f[k][0].value||f[k][0]):(f[k]||null);
  return pick('owner')||pick('record owner')||'';
}
function tagsOf(c){const t=c.tags||c.tag_list||[];return t.map(x=>(typeof x==='string'?x:(x&&(x.tag||x.name||x.value))||'')).filter(Boolean);}

/* ---- last-contacted (best effort; Nimble shape varies) ---- */
function pickField(f,k){ if(!f)return null; const v=f[k]; if(Array.isArray(v)&&v[0])return v[0].value||v[0]; return v||null; }
function lastContactDaysOf(c){
  const f=c.fields||{};
  const cand=c.last_contacted_date||c.last_contacted||c.last_contact_time||c.lastcontacted||pickField(f,'last contacted')||pickField(f,'last contacted date');
  if(!cand)return null; const t=Date.parse(cand); if(isNaN(t))return null;
  return Math.max(0,Math.round((Date.now()-t)/864e5));
}

/* ---- deals / opportunities ---- */
function dealNum(v){ if(v==null)return 0; if(typeof v==='object')return +(v.value!=null?v.value:v.amount!=null?v.amount:0)||0; return +v||0; }
function dealStage(d){ const s=d.stage!=null?d.stage:d.stage_name; if(s&&typeof s==='object')return s.name||s.title||s.label||''; return (typeof s==='string'?s:'')||''; }
function dealProb(d){ let p=d.probability; if(p==null&&d.stage&&typeof d.stage==='object')p=d.stage.probability; return p!=null?+p:null; }
function dealClose(d){ return d.expected_close_date||d.close_date||d.closed_date||d.due_date||d.expected_close||null; }
function dealCreated(d){ return d.found_time||d.created||d.created_at||d.creation_date||d.added||null; }
function dealStatus(d){ return (d.status||d.state||(d.stage&&d.stage.type)||'').toString().toLowerCase(); }
function ageDaysOf(d){ const c=dealCreated(d); if(!c)return null; const t=Date.parse(c); if(isNaN(t))return null; return Math.max(0,Math.round((Date.now()-t)/864e5)); }
// every contact id a deal references (company ids will match account.crmId; person ids simply won't)
function dealContactIds(d){
  const ids=new Set();
  const add=x=>{ if(x==null)return; const id=(typeof x==='object')?(x.contact_id||x.id||x.record_id||(x.contact&&x.contact.id)):x; if(id!=null)ids.add(String(id)); };
  const rc=d.related_contacts||d.contacts||d.related||d.parties||[];
  if(Array.isArray(rc))rc.forEach(add);
  add(d.company_id); add(d.primary_contact_id); add(d.account_id);
  if(d.company&&typeof d.company==='object')add(d.company);
  return [...ids];
}
// --- Nimble v2 deal field readers ---
function dealFV(d,name){ const fv=d&&d.fields_values_with_names; if(!fv||typeof fv!=='object')return null; const arr=fv[name]; if(Array.isArray(arr)&&arr.length){ const p=arr.find(x=>x&&x.is_primary)||arr[0]; return p&&p.value!=null?p.value:null; } return null; }
function stageInfo(d){ const s=d&&d.stage; if(s&&typeof s==='object')return { name:s.name||'', role:(s.role&&s.role.name)||'', final:!!(s.role&&s.role.is_final) }; return { name:(typeof s==='string'?s:''), role:'', final:false }; }
function normDeal(d){
  const si=stageInfo(d);
  const val=+(((dealFV(d,'amount')||dealFV(d,'value')||'0')+'').replace(/[^0-9.\-]/g,''))||0;
  const prob=(d.final_probability!=null?+d.final_probability:(dealFV(d,'probability')!=null?+dealFV(d,'probability'):null));
  return { id:d.deal_id||d.id||null, title:dealFV(d,'name')||dealFV(d,'title')||si.name||'(untitled deal)',
    value:val, stage:si.name, stageRole:si.role, isFinal:si.final, probability:prob,
    closeDate:dealFV(d,'expected_close_date')||dealFV(d,'actual_close_date')||null,
    ageDays:(d.age_in_days!=null?d.age_in_days:ageDaysOf(d)),
    owner:(d.owner&&typeof d.owner==='object'?(d.owner.name||''):(d.owner||'')), pipeline:d.pipeline_name||'' };
}
// Fetch all deals; returns { byContactId: Map(id -> [normDeal]), count, error }
async function fetchJSON(url,hdr,timeoutMs){
  const ac=new AbortController(); const to=setTimeout(()=>ac.abort(),timeoutMs||10000);
  try{ const res=await fetch(url,{headers:hdr,signal:ac.signal}); const text=await res.text().catch(()=> ''); let json=null; try{ json=text?JSON.parse(text):null; }catch(e){} return {ok:res.ok,status:res.status,json,text}; }
  finally{ clearTimeout(to); }
}
// Fetch OPEN deals. Page 1 is the oldest deals, so the live pipeline lives on the
// last pages — we fetch from the newest end, bounded + concurrent, and keep only
// deals whose stage is not final (not won/lost). Attaches by related contact id.
async function fetchDeals(token,opts){
  opts=opts||{};
  const perPage=100, conc=4, maxFetch=opts.dealsMaxFetch||30;   // up to ~3000 newest deals
  const byId={}; let scanned=0, open=0;
  const stageCount={}; let sample=null, sampleErr=null;
  const hdr={ 'X-Nimble-Token':token, 'Authorization':`Bearer ${token}`, 'Accept':'application/json' };
  const budgetMs=9000, t0=Date.now();
  const getPage=p=>fetchJSON(`https://app.nimble.com/api/v2/deals?per_page=${perPage}&page=${p}`,hdr,5000);
  const first=await getPage(1);
  if(!first.ok) return { byId, scanned:0, open:0, error:`deals ${first.status}: ${(first.text||'').slice(0,160)}`, dbg:{status:first.status,stageCount,sample,sampleErr} };
  const meta1=(first.json&&first.json.meta)||{}; const pages=meta1.pages||1; const dealTotal=meta1.total||null;
  const process=list=>{ for(const d of (list||[])){ scanned++; let nd; try{ nd=normDeal(d); }catch(e){ if(!sampleErr)sampleErr=String(e&&e.message||e); continue; } stageCount[nd.stage]=(stageCount[nd.stage]||0)+1; const isOpen=!nd.isFinal && nd.stageRole!=='won' && nd.stageRole!=='lost'; if(!isOpen)continue; open++; if(!sample)sample={ title:nd.title, value:nd.value, stage:nd.stage, role:nd.stageRole, prob:nd.probability, close:nd.closeDate, owner:nd.owner, pipeline:nd.pipeline }; try{ for(const cid of dealContactIds(d)){ (byId[cid]=byId[cid]||[]).push(nd); } }catch(e){} } };
  if(pages<=1){ process((first.json&&first.json.resources)||[]); return { byId, scanned, open, error:null, dbg:{ dealTotal, pages, pagesQueued:1, stageCount, sample, sampleErr, ms:Date.now()-t0 } }; }
  const startP=pages, endP=Math.max(2,pages-maxFetch+1);
  const queue=[]; for(let p=startP;p>=endP;p--)queue.push(p);
  let qi=0, budgetHit=false;
  async function worker(){ while(qi<queue.length){ if(Date.now()-t0>budgetMs){budgetHit=true;return;} const p=queue[qi++]; let r=null; try{ r=await getPage(p); }catch(e){} if(r&&r.ok&&r.json){ process(r.json.resources||[]); } } }
  const ws=[]; for(let i=0;i<conc;i++)ws.push(worker()); await Promise.all(ws);
  return { byId, scanned, open, error:null, dbg:{ dealTotal, pages, pagesQueued:queue.length, budgetHit, stageCount, sample, sampleErr, ms:Date.now()-t0 } };
}

async function fetchPageSafe(token,page,perPage){
  try{ return await fetchPage(token,page,perPage); }
  catch(e){ return { resources:[], __err:String(e&&e.message||e) }; }
}
async function getCrmData(token,opts){
  opts=opts||{};
  const perPage=opts.perPage||100, maxPages=opts.maxPages||200, conc=opts.conc||4;
  const tAll=Date.now();
  const accounts=[]; const pageErrs=[];
  const collect=data=>{
    const list=data.resources||data.contacts||[];
    for(const c of list){
      const tags=tagsOf(c); const r=resolveAccount(tags);
      accounts.push({ crmId:c.id||c.record_id||null, name:nameOf(c), tags,
        active:r.active, dormant:r.dormant, amCode:r.amCode, am:r.am,
        owner_id:(c.owner_id!=null?c.owner_id:(c.owner&&c.owner.id)||null), owner_name:ownerNameOf(c),
        lastContactDays:lastContactDaysOf(c), pipeline:[] });
    }
    if(data.__err)pageErrs.push(data.__err);
  };
  const tC=Date.now();
  // page 1 first to learn the total page count, then fetch 2..N in parallel (bounded).
  const first=await fetchPage(token,1,perPage); collect(first);
  let pages=(first.meta&&(first.meta.pages||first.meta.total_pages))||1;
  const total=Math.min(pages,maxPages);
  let next=2;
  async function worker(){ while(next<=total){ const p=next++; collect(await fetchPageSafe(token,p,perPage)); } }
  const workers=[]; for(let i=0;i<Math.min(conc,Math.max(0,total-1));i++)workers.push(worker());
  await Promise.all(workers);
  const msContacts=Date.now()-tC;

  // deals: fetch once, attach to accounts by matching contact id -> crmId.
  // Fully isolated: any failure here must never break the accounts feed.
  let deals={byId:{},open:0,scanned:0,error:null,dbg:null};
  const tD=Date.now();
  try{ deals=await fetchDeals(token, opts); }
  catch(e){ deals={byId:{},open:0,scanned:0,error:'fetchDeals threw: '+String(e&&e.message||e),dbg:null}; }
  const msDeals=Date.now()-tD;
  let attached=0;
  if(deals && deals.byId){
    for(const a of accounts){ const key=a.crmId!=null?String(a.crmId):null; if(key&&deals.byId[key]){ a.pipeline=deals.byId[key]; attached+=a.pipeline.length; } }
  }
  return { generated:new Date().toISOString(), source:'nimble', accounts,
    meta:{ nimbleVersion:'2026-10-30-v8-open', pages, count:accounts.length, active:accounts.filter(a=>a.active).length,
      msContacts, msDeals, msTotal:Date.now()-tAll, pageErrs:pageErrs.slice(0,3),
      deals:(deals?deals.open:0), scanned:(deals?deals.scanned:0), dealsAttached:attached,
      dealsError:(deals?deals.error:'not fetched'), dealsDebug:(deals?deals.dbg:null) } };
}
module.exports = { getCrmData };

function companyNameOf(c){ const f=c.fields||{}; const pick=k=>Array.isArray(f[k])&&f[k][0]?(f[k][0].value||f[k][0]):null; return pick('company name')||pick('company')||''; }
const AM_CODES=['DMcD','DOC','DF','DG','SC','MD','EB','EJ','EG'];
function tagCodes(tags){ const out=[]; (tags||[]).forEach(t=>{ if(!/accounts?/i.test(t))return; for(const code of AM_CODES){ const re=new RegExp('(^|[^a-z])'+code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^a-z]|$)','i'); if(re.test(t)){ if(out.indexOf(code)<0)out.push(code); break; } } }); return out; }
function tagPairs(tags){ const out=[]; (tags||[]).forEach(t=>{ if(!/accounts?/i.test(t))return; for(const code of AM_CODES){ const re=new RegExp('(^|[^a-z])'+code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^a-z]|$)','i'); if(re.test(t)){ out.push({t:t,code:code}); break; } } }); return out; }
// One page of contacts (persons) -> [{company, codes}] with hasMore, for client-side paging.
async function getContactTags(token, opts){
  opts=opts||{}; const page=(opts.page!=null?opts.page:0)+1; const perPage=100;
  const url=`${NIMBLE_BASE}/contacts?record_type=person&per_page=${perPage}&page=${page}`;
  const res=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  if(!res.ok){ const b=await res.text().catch(()=> ''); throw new Error(`Nimble contacts ${res.status}: ${b.slice(0,160)}`); }
  const data=await res.json();
  const list=data.resources||data.contacts||[];
  const rows=[];
  for(const c of list){ const tg=tagsOf(c); const pairs=tagPairs(tg); if(!pairs.length)continue; const company=companyNameOf(c); if(!company)continue; rows.push({company, codes:pairs.map(p=>p.code), raw:pairs}); }
  const pages=(data.meta&&(data.meta.pages||data.meta.total_pages))||page;
  return { source:'nimbletags', page:opts.page||0, rows, hasMore: page<pages };
}
module.exports.getContactTags = getContactTags;
