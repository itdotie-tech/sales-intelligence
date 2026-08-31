const { getCrmData } = require('../shared/nimble');
const { getNetsuiteData } = require('../shared/netsuite');
module.exports = async function (context, req) {
  const id = String(context.bindingData.id || '').toLowerCase();
  const pageRaw = req.query && req.query.page;
  const page = (pageRaw!=null && pageRaw!=='') ? parseInt(pageRaw,10) : null;
  try {
    if (id === 'nimble') {
      const token = process.env.NIMBLE_ACCESS_TOKEN;
      if (!token) { context.res = { status:500, body:'NIMBLE_ACCESS_TOKEN is not set.' }; return; }
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(await getCrmData(token)) }; return;
    }
    if (id === 'netsuite') {
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(await getNetsuiteData({ page })) }; return;
    }
    context.res = { status:404, body:`Unknown source '${id}'.` };
  } catch (e) { context.res = { status:502, body:'Source fetch failed: ' + (e.message || String(e)) }; }
};
