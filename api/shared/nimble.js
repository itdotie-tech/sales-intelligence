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
async function getCrmData(token,opts){opts=opts||{};const perPage=opts.perPage||30,maxPages=opts.maxPages||200;const accounts=[];let page=1,pages=1;do{const data=await fetchPage(token,page,perPage);const list=data.resources||data.contacts||[];for(const c of list){const tags=tagsOf(c);const r=resolveAccount(tags);accounts.push({crmId:c.id||c.record_id||null,name:nameOf(c),tags,active:r.active,dormant:r.dormant,amCode:r.amCode,am:r.am,owner_id:(c.owner_id!=null?c.owner_id:(c.owner&&c.owner.id)||null),owner_name:ownerNameOf(c)});}pages=(data.meta&&(data.meta.pages||data.meta.total_pages))||pages;page++;}while(page<=pages&&page<=maxPages);return{generated:new Date().toISOString(),source:'nimble',accounts,meta:{pages,count:accounts.length,active:accounts.filter(a=>a.active).length}};}
module.exports = { getCrmData };
