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
function normDeal(d){
  return { id:d.id||d.record_id||null, title:d.title||d.name||d.stage_name||'(untitled deal)',
    value:dealNum(d.value!=null?d.value:d.amount), stage:dealStage(d), probability:dealProb(d),
    closeDate:dealClose(d), ageDays:ageDaysOf(d), status:dealStatus(d) };
}
// Fetch all deals; returns { byContactId: Map(id -> [normDeal]), count, error }
async function fetchJSON(url,hdr,timeoutMs){
  const ac=new AbortController(); const to=setTimeout(()=>ac.abort(),timeoutMs||10000);
  try{ const res=await fetch(url,{headers:hdr,signal:ac.signal}); const text=await res.text().catch(()=> ''); let json=null; try{ json=text?JSON.parse(text):null; }catch(e){} return {ok:res.ok,status:res.status,json,text}; }
  finally{ clearTimeout(to); }
}
async function fetchDeals(token,perPage,maxPages){
  perPage=perPage||100; maxPages=maxPages||20;       // bounded so the function can't run long
  const byId={}; let count=0, raw=0, page=1, pages=1;
  const stageSet=new Set(), pipeSet=new Set();
  const dbg={status:null,topKeys:null,listKey:null,listLen:null,metaKeys:null,dealTotal:null,dealPages:null,firstKeys:null,firstStatus:null,firstContactIds:null,sample:null,stages:null,pipelines:null,stopped:null};
  // Current Nimble Deals API is v2 on app.nimble.com, authed with X-Nimble-Token.
  // Send both auth styles so a Bearer-style token also works if that's what we hold.
  const hdr={ 'X-Nimble-Token':token, 'Authorization':`Bearer ${token}`, 'Accept':'application/json' };
  const budgetMs=8000, t0=Date.now();
  try{
    do{
      if(Date.now()-t0>budgetMs){ dbg.stopped='time-budget'; break; }
      const url=`https://app.nimble.com/api/v2/deals?per_page=${perPage}&page=${page}`;
      const r=await fetchJSON(url,hdr,5000);
      if(page===1) dbg.status=r.status;
      if(!r.ok){ return { byId, count, raw, error:`deals ${r.status}: ${(r.text||'').slice(0,160)}`, dbg }; }
      const data=r.json||{};
      let list=data.resources, lk='resources';
      if(!Array.isArray(list)){ if(Array.isArray(data.deals)){list=data.deals;lk='deals';} else if(Array.isArray(data.data)){list=data.data;lk='data';} else if(Array.isArray(data.results)){list=data.results;lk='results';} else if(Array.isArray(data)){list=data;lk='(array)';} else {list=[];lk='(none)';} }
      if(page===1){ dbg.topKeys=Object.keys(data||{}).slice(0,25); dbg.listKey=lk; dbg.listLen=list.length; if(data&&data.meta&&typeof data.meta==='object'){dbg.metaKeys=Object.keys(data.meta).slice(0,15);dbg.dealTotal=data.meta.total;dbg.dealPages=data.meta.pages;} if(list[0]){ const s0=list[0]; dbg.firstKeys=Object.keys(s0).slice(0,50); dbg.firstStatus=dealStatus(s0); dbg.firstContactIds=dealContactIds(s0).slice(0,8); dbg.sample={ deal_id:s0.deal_id, stage:s0.stage, pipeline_name:s0.pipeline_name, final_probability:s0.final_probability, age_in_days:s0.age_in_days, owner:s0.owner, fields_values_with_names:s0.fields_values_with_names, stage_transitions:(s0.stage_transitions||[]).slice(0,3) }; } }
      for(const d of list){
        raw++;
        stageSet.add(dealStage(d)); if(d.pipeline_name)pipeSet.add(d.pipeline_name);
        const st=dealStatus(d); if(st==='won'||st==='lost'||st==='closed') continue;
        const nd=normDeal(d); count++;
        for(const cid of dealContactIds(d)){ (byId[cid]=byId[cid]||[]).push(nd); }
      }
      pages=(data.meta&&(data.meta.pages||data.meta.total_pages||data.meta.page_count))||pages; page++;
    }while(page<=pages&&page<=maxPages);
  }catch(e){ dbg.stages=[...stageSet].slice(0,40); dbg.pipelines=[...pipeSet].slice(0,20); return { byId, count, raw, error:String(e&&(e.name==='AbortError'?'timeout':e.message)||e), dbg }; }
  dbg.stages=[...stageSet].slice(0,40); dbg.pipelines=[...pipeSet].slice(0,20);
  return { byId, count, raw, error:null, dbg };
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
  let deals={byId:{},count:0,raw:0,error:null,dbg:null};
  const tD=Date.now();
  try{ deals=await fetchDeals(token, opts.dealsPerPage, opts.dealsMaxPages); }
  catch(e){ deals={byId:{},count:0,raw:0,error:'fetchDeals threw: '+String(e&&e.message||e),dbg:null}; }
  const msDeals=Date.now()-tD;
  let attached=0;
  if(deals && deals.byId){
    for(const a of accounts){ const key=a.crmId!=null?String(a.crmId):null; if(key&&deals.byId[key]){ a.pipeline=deals.byId[key]; attached+=a.pipeline.length; } }
  }
  return { generated:new Date().toISOString(), source:'nimble', accounts,
    meta:{ nimbleVersion:'2026-10-30-v5-test', pages, count:accounts.length, active:accounts.filter(a=>a.active).length,
      msContacts, msDeals, msTotal:Date.now()-tAll, pageErrs:pageErrs.slice(0,3),
      deals:(deals?deals.count:0), rawDeals:(deals?deals.raw:0), dealsAttached:attached,
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
