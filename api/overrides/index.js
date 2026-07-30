/* GET  /api/overrides  -> shared corrections, readable by any signed-in user
   POST /api/overrides  -> merge a patch into the store, admins only
   A patch looks like { ownerOverrides:{"Client X":"David Flood"} }; a null value removes a key. */
const { isAdmin, getPrincipal } = require('../shared/auth');
const { readOverrides, writeOverrides, applyPatch } = require('../shared/store');

module.exports = async function (context, req) {
  try {
    if (req.method === 'GET') {
      const data = await readOverrides();
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) };
      return;
    }
    if (req.method === 'POST') {
      if (!isAdmin(req)) { context.res = { status:403, body:'Admins only. Corrections are pushed by an administrator.' }; return; }
      let patch = req.body;
      if (typeof patch === 'string') { try { patch = JSON.parse(patch); } catch(e){ patch = {}; } }
      patch = patch || {};
      const merged = applyPatch(await readOverrides(), patch);
      const p = getPrincipal(req);
      merged.updatedAt = new Date().toISOString();
      merged.updatedBy = (p && (p.userDetails || p.userId)) || 'unknown';
      await writeOverrides(merged);
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(merged) };
      return;
    }
    context.res = { status:405, body:'Method not allowed.' };
  } catch (e) {
    context.res = { status:502, body:'Overrides store error: ' + (e.message || String(e)) };
  }
};
