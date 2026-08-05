/* Serves a named data source to the dashboard.
   NOTE: the admin gate is temporarily lifted so we can confirm the data pipeline
   end to end. Security is reinstated in the next step via simple sign-in.
   The Nimble token is still read only from configuration, never the browser. */
const { getCrmData } = require('../shared/nimble');

module.exports = async function (context, req) {
  const id = String(context.bindingData.id || '').toLowerCase();
  try {
    if (id === 'nimble') {
      const token = process.env.NIMBLE_ACCESS_TOKEN;
      if (!token) { context.res = { status: 500, body: 'NIMBLE_ACCESS_TOKEN is not set in Application settings.' }; return; }
      const data = await getCrmData(token);
      context.res = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
      return;
    }
    if (id === 'netsuite') { context.res = { status: 501, body: 'NetSuite is not configured yet.' }; return; }
    context.res = { status: 404, body: `Unknown source '${id}'.` };
  } catch (e) {
    context.res = { status: 502, body: 'Source fetch failed: ' + (e.message || String(e)) };
  }
};
