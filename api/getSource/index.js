const { getCrmData } = require('../shared/nimble');
const { getNetsuiteData } = require('../shared/netsuite');
const { getContactTags } = require('../shared/nimble');
module.exports = async function (context, req) {
  const id = String(context.bindingData.id || '').toLowerCase();
  const pageRaw = req.query && req.query.page;
  const page = (pageRaw!=null && pageRaw!=='') ? parseInt(pageRaw,10) : null;
  const from = (req.query && req.query.from) || null;
  const to = (req.query && req.query.to) || null;
  try {
    if (id === 'nimble') {
      const token = process.env.NIMBLE_ACCESS_TOKEN;
      if (!token) { context.res = { status:500, body:'NIMBLE_ACCESS_TOKEN is not set.' }; return; }
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(await getCrmData(token)) }; return;
    }
    if (id === 'nimbletags') {
      const token = process.env.NIMBLE_ACCESS_TOKEN;
      if (!token) { context.res = { status:500, body:'NIMBLE_ACCESS_TOKEN is not set.' }; return; }
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(await getContactTags(token, { page })) }; return;
    }
    if (id === 'netsuite') {
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(await getNetsuiteData({ page, from, to })) }; return;
    }
    if (id === 'autotask') {
      // Device counts are written nightly to blob storage by an office-network
      // job (the warehouse is IP-restricted, so neither the browser nor this
      // function can query it directly). Lazy require keeps storage faults off
      // the NetSuite / Nimble feeds above.
      const { readJsonBlob } = require('../shared/store');
      const data = await readJsonBlob('autotask-devices.json');
      if (!data) { context.res = { status:404, body:'No Autotask sync file found yet. The office device has not written one.' }; return; }
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) }; return;
    }
    if (id === 'autotask-support') {
      // Per-client ticket volume, worked hours and issue mix, written nightly by
      // the same office job (automated/internal tickets already excluded).
      const { readJsonBlob } = require('../shared/store');
      const data = await readJsonBlob('autotask-support.json');
      if (!data) { context.res = { status:404, body:'No Autotask support file found yet.' }; return; }
      context.res = { headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) }; return;
    }
    context.res = { status:404, body:`Unknown source '${id}'.` };
  } catch (e) { context.res = { status:502, body:'Source fetch failed: ' + (e.message || String(e)) }; }
};
