/* Central store for manual corrections (account managers, name links, renames).
   Backed by a single JSON blob so every user sees the same values.
   Reads need only a connection string; writes are gated to admins in the endpoint. */
const { BlobServiceClient } = require('@azure/storage-blob');
const CONTAINER = process.env.DATASET_CONTAINER || 'data-sync';
const BLOB = 'overrides.json';
const EMPTY = { ownerOverrides:{}, nameCrosswalk:{}, clientRenames:{}, updatedAt:null, updatedBy:null };

function container(){
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
// merge a small patch into the stored object; a null value deletes that key
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
