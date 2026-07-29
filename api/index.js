/* Serves a named data source to the dashboard.
   A live pull uses server-side credentials, so it is gated to admins.
   The token is read from configuration (Application setting or Key Vault
   reference); it never appears in this code or in any response. */
const { isAdmin } = require('../shared/auth');
const { getCrmData } = require('../shared/nimble');

module.exports = async function (context, req) {
  const id = String(context.bindingData.id || '').toLowerCase();

  if (!isAdmin(req)) {
    context.res = { status: 403, body: 'Admins only. API sources are managed by an administrator.' };
    return;
  }

  try {
    if (id === 'nimble') {
      const token = process.env.NIMBLE_ACCESS_TOKEN;
      if (!token) {
        context.res = { status: 500, body: 'NIMBLE_ACCESS_TOKEN is not set. Add it in the Static Web App Application settings.' };
        return;
      }
      const data = await getCrmData(token);
      context.res = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
      return;
    }

    if (id === 'netsuite') {
      context.res = { status: 501, body: 'NetSuite is not configured yet. Add the five NetSuite values and the NetSuite puller, then try again.' };
      return;
    }

    context.res = { status: 404, body: `Unknown source '${id}'.` };
  } catch (e) {
    context.res = { status: 502, body: 'Source fetch failed: ' + (e.message || String(e)) };
  }
};
