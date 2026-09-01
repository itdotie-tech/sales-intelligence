/* Shared corrections endpoint. GET returns the saved overrides; POST merges a
   patch and saves. Access is gated by the site sign-in (staticwebapp.config.json),
   so any signed-in user can read and save. Fails gracefully if storage is not set. */
const { readOverrides, writeOverrides, applyPatch } = require('../shared/store');
module.exports = async function(context, req){
  try{
    if(req.method==='GET'){
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(await readOverrides()) }; return;
    }
    if(req.method==='POST'){
      const patch = req.body || {};
      const next = applyPatch(await readOverrides(), patch);
      next.updatedAt = new Date().toISOString();
      let who=''; try{ const p=req.headers['x-ms-client-principal']; if(p){ who=(JSON.parse(Buffer.from(p,'base64').toString('utf8')).userDetails)||''; } }catch(e){}
      next.updatedBy = who;
      await writeOverrides(next);
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ok:true, updatedAt:next.updatedAt, updatedBy:next.updatedBy }) }; return;
    }
    context.res = { status:405, body:'Method not allowed' };
  }catch(e){ context.res = { status:502, body:'Overrides store error: ' + (e.message||String(e)) }; }
};
