/* Central store for manual corrections (account managers, name links, renames).
   Backed by a single JSON blob so every user sees the same values.

   IMPORTANT: the Azure storage SDK is loaded lazily, inside the functions that
   use it, not at module load. That way, if the package is not installed or the
   storage is not configured, ONLY the overrides endpoint is affected — the rest
   of the API (getSource / Nimble) keeps working. */
const CONTAINER = process.env.DATASET_CONTAINER || 'data-sync';
const BLOB = 'overrides.json';
const EMPTY = { ownerOverrides:{}, nameCrosswalk:{}, clientRenames:{}, updatedAt:null, updatedBy:null };

let _sdk = null;
function sdk(){
  if(_sdk) return _sdk;
  try { _sdk = require('@azure/storage-blob'); }
  catch(e){ throw new Error('Storage library not installed. Add "@azure/storage-blob" to api/package.json and redeploy.'); }
  return _sdk;
}
function container(){
  const { BlobServiceClient } = sdk();
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if(!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not set in Application settings.');
  return BlobServiceClient.fromConnectionString(cs).getContainerClient(CONTAINER);
}
async function readOverrides(){
  const c = container(); await c.createIfNotExists();
  const b = c.getBlockBlobClient(BLOB);
  if(!(await b.exists())) return { ...EMPTY };
  const buf = await b.downloadToBuffer();
  try { return { ...EMPTY, ...JSON.parse(buf.toString('utf8')) }; }
  catch(e){ return { ...EMPTY }; }
}
async function writeOverrides(obj){
  const c = container(); await c.createIfNotExists();
  const b = c.getBlockBlobClient(BLOB);
  const body = JSON.stringify(obj);
  await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders:{ blobContentType:'application/json' } });
  return obj;
}
function applyPatch(cur, patch){
  const out = {
    ownerOverrides: { ...cur.ownerOverrides, ...(patch.ownerOverrides||{}) },
    nameCrosswalk:  { ...cur.nameCrosswalk,  ...(patch.nameCrosswalk||{}) },
    clientRenames:  { ...cur.clientRenames,  ...(patch.clientRenames||{}) },
  };
  for(const grp of ['ownerOverrides','nameCrosswalk','clientRenames']){
    for(const k of Object.keys(patch[grp]||{})){ if(patch[grp][k]===null) delete out[grp][k]; }
  }
  return out;
}
module.exports = { readOverrides, writeOverrides, applyPatch, EMPTY };
