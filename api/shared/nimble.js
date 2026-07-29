/* ============================================================
   Nimble CRM puller  →  normalised "CRM contract"
   Runs inside the Azure Function. Reads the token from the
   environment (a Key Vault reference), never from the browser.

   What it returns is the shape the dashboard consumes:
     { generated, source:'nimble', accounts:[ {
         crmId, name, tags,
         active, dormant, amCode, am     // from the account tags
       } ], meta:{ pages, count } }

   The dashboard then cross-references each account against NetSuite
   revenue to decide billing vs migrating (see crm-resolve.resolveStatus).

   CONFIRM AGAINST A LIVE PULL (marked //! below):
     - the exact shape of a contact's tags (string vs object)
     - which field carries the company name
     - where the record owner lives, if you want owner as a cross-check
       (the account tag already gives the manager, so this is optional)
   ============================================================ */
const { resolveAccount } = require('./crm-resolve');

const NIMBLE_BASE = 'https://api.nimble.com/api/v1';

// Pull one page of company records.
async function fetchPage(token, page, perPage){
  const url = `${NIMBLE_BASE}/contacts?record_type=company&per_page=${perPage}&page=${page}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if(res.status === 401 || res.status === 403){
    const body = await res.text().catch(()=> '');
    throw new Error(`Nimble auth failed (${res.status}). Check the token in Key Vault. ${body.slice(0,200)}`);
  }
  if(!res.ok) throw new Error(`Nimble returned ${res.status} for page ${page}.`);
  return res.json();
}

// Pull the company name out of a contact record, tolerant of shape.
function nameOf(c){
  const f = c.fields || {};
  //! confirm: company records usually carry the name under 'company name'
  const pick = k => Array.isArray(f[k]) && f[k][0] ? (f[k][0].value || f[k][0]) : null;
  return pick('company name') || pick('name') || c.name || c.display_name || '(unnamed)';
}

// Normalise tags to a plain string array, tolerant of string-or-object.
function tagsOf(c){
  const t = c.tags || c.tag_list || [];
  //! confirm: tags may arrive as ['DF Accounts'] or [{tag:'DF Accounts'}]
  return t.map(x => (typeof x === 'string' ? x : (x && (x.tag || x.name || x.value)) || '')).filter(Boolean);
}

async function getCrmData(token, opts){
  opts = opts || {};
  const perPage = opts.perPage || 30;
  const maxPages = opts.maxPages || 200;      // safety ceiling
  const accounts = [];
  let page = 1, pages = 1;

  do {
    const data = await fetchPage(token, page, perPage);
    const list = data.resources || data.contacts || [];
    for(const c of list){
      const tags = tagsOf(c);
      const r = resolveAccount(tags);          // active / dormant / manager, from the tags
      accounts.push({
        crmId: c.id || c.record_id || null,
        name: nameOf(c),
        tags,
        active: r.active, dormant: r.dormant, amCode: r.amCode, am: r.am,
      });
    }
    pages = (data.meta && (data.meta.pages || data.meta.total_pages)) || pages;
    page++;
  } while(page <= pages && page <= maxPages);

  return {
    generated: new Date().toISOString(),
    source: 'nimble',
    accounts,
    meta: {
      pages,
      count: accounts.length,
      active: accounts.filter(a => a.active).length,
      byManager: accounts.filter(a=>a.active).reduce((m,a)=>{ m[a.am]=(m[a.am]||0)+1; return m; }, {}),
    },
  };
}

module.exports = { getCrmData, nameOf, tagsOf };
