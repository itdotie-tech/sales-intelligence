// Reads the signed-in identity that Static Web Apps injects into every API
// call, and checks for the admin role. This is the real lock: it does not
// depend on the browser hiding a panel.
function getPrincipal(req){
  const h = req.headers['x-ms-client-principal'];
  if(!h) return null;
  try { return JSON.parse(Buffer.from(h,'base64').toString('utf8')); }
  catch(e){ return null; }
}
function isAdmin(req){
  const p = getPrincipal(req);
  return !!(p && Array.isArray(p.userRoles) && p.userRoles.includes('admin'));
}
module.exports = { getPrincipal, isAdmin };
