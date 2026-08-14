/* Serves a named data source to the dashboard. Credentials from configuration
   only, never the browser. Access is gated by the sign-in requirement in
   staticwebapp.config.json. */
const { getCrmData } = require('../shared/nimble');
const { getNetsuiteData } = require('../shared/netsuite');

module.exports = async function (context, req) {
  const id = String(context.bindingData.id || '').toLowerCase();
  try {
    if (id === 'nimble') {
      const token = process.env.NIMBLE_ACCESS_TOKEN;
      if (!token) { context.res = { status: 500, body: 'NIMBLE_ACCESS_TOKEN is not set.' }; return; }
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(await getCrmData(token)) };
      return;
    }
    if (id === 'netsuite') {
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(await getNetsuiteData()) };
      return;
    }
    context.res = { status: 404, body: `Unknown source '${id}'.` };
  } catch (e) {
    context.res = { status: 502, body: 'Source fetch failed: ' + (e.message || String(e)) };
  }
};
