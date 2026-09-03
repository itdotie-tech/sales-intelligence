/* Shared corrections store (owner assignments, name links, renames).
   Zero external dependencies: talks to Azure Blob storage over HTTPS using
   Node's built-in crypto + fetch. getSource never imports this, so storage
   problems can only affect the overrides endpoint, never the data feeds. */
const crypto = require('crypto');
const CONTAINER = process.env.DATASET_CONTAINER || 'data-sync';
const BLOB = 'overrides.json';
const VERSION = '2021-08-06';
const EMPTY = { ownerOverrides:{}, nameCrosswalk:{}, clientRenames:{}, ownerIdMap:{}, updatedAt:null, updatedBy:null };

function conn(){
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if(!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not set in Application settings.');
  const p={}; cs.split(';').forEach(kv=>{ const i=kv.indexOf('='); if(i>0) p[kv.slice(0,i).trim()]=kv.slice(i+1).trim(); });
  if(!p.AccountName||!p.AccountKey) throw new Error('Connection string is missing AccountName or AccountKey.');
  return { account:p.AccountName, key:p.AccountKey, host:`${p.AccountName}.blob.${p.EndpointSuffix||'core.windows.net'}`, proto:p.DefaultEndpointsProtocol||'https' };
}
function authHeader(c, method, path, query, headers, bodyLen){
  const canon = Object.keys(headers).filter(k=>k.startsWith('x-ms-')).sort().map(k=>`${k}:${headers[k]}`).join('\n');
  const qk = Object.keys(query).sort();
  const cr = `/${c.account}/${path}` + (qk.length?'\n'+qk.map(k=>`${k}:${query[k]}`).join('\n'):'');
  const clen = bodyLen>0?String(bodyLen):'';
  const sts = [method,'','',clen,'',headers['content-type']||'','','','','','',''].join('\n')+'\n'+canon+'\n'+cr;
  const sig = crypto.createHmac('sha256', Buffer.from(c.key,'base64')).update(sts,'utf8').digest('base64');
  return `SharedKey ${c.account}:${sig}`;
}
async function request(method, path, query, extra, body){
  const c=conn(); const q=query||{};
  const headers=Object.assign({ 'x-ms-date':new Date().toUTCString(), 'x-ms-version':VERSION }, extra||{});
  const bodyLen=body!=null?Buffer.byteLength(body):0;
  const lower={}; Object.keys(headers).forEach(k=>lower[k.toLowerCase()]=headers[k]);
  headers['Authorization']=authHeader(c, method, path, q, lower, bodyLen);
  const qs=Object.keys(q).length?'?'+Object.keys(q).map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`).join('&'):'';
  return fetch(`${c.proto}://${c.host}/${path}${qs}`, { method, headers, body });
}
async function ensureContainer(){ await request('PUT', CONTAINER, { restype:'container' }, {}, null); }
async function readOverrides(){
  await ensureContainer();
  const r=await request('GET', `${CONTAINER}/${BLOB}`, {}, {}, null);
  if(r.status===404) return { ...EMPTY };
  if(!r.ok) throw new Error('Storage read failed ('+r.status+').');
  try{ return { ...EMPTY, ...JSON.parse(await r.text()) }; }catch(e){ return { ...EMPTY }; }
}
async function writeOverrides(obj){
  await ensureContainer();
  const body=JSON.stringify(obj);
  const r=await request('PUT', `${CONTAINER}/${BLOB}`, {}, { 'x-ms-blob-type':'BlockBlob', 'content-type':'application/json' }, body);
  if(!r.ok) throw new Error('Storage write failed ('+r.status+').');
  return obj;
}
function applyPatch(cur, patch){
  const out={ ownerOverrides:{...cur.ownerOverrides,...(patch.ownerOverrides||{})},
    nameCrosswalk:{...cur.nameCrosswalk,...(patch.nameCrosswalk||{})},
    clientRenames:{...cur.clientRenames,...(patch.clientRenames||{})},
    ownerIdMap:{...(cur.ownerIdMap||{}),...(patch.ownerIdMap||{})} };
  for(const g of ['ownerOverrides','nameCrosswalk','clientRenames','ownerIdMap']) for(const k of Object.keys(patch[g]||{})) if(patch[g][k]===null) delete out[g][k];
  return out;
}
module.exports = { readOverrides, writeOverrides, applyPatch, EMPTY };
