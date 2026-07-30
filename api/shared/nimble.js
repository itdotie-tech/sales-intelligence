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

  // best-effort enrichment; each guarded so failure leaves accounts intact
  try{
    const [recency, deals] = await Promise.all([ fetchActivityRecency(token), fetchDeals(token) ]);
    for(const a of accounts){
      if(a.crmId!=null){
        const last=recency[a.crmId];
        if(last){ a.lastContactDays = Math.max(0, Math.round((Date.now()-new Date(last))/864e5)); }
        const dl=deals[a.crmId]; if(dl&&dl.length) a.pipeline = dl;
      }
      if(!a.pipeline) a.pipeline=[];
    }
  }catch(e){ /* enrichment optional */ }

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

/* ------------------------------------------------------------------
   Deals + activity enrichment (powers Pipeline Health, Lead Scoring, Churn).
   Nimble's deal and activity shapes vary by plan, so both are best-effort and
   fail safe: if an endpoint is not reachable, accounts simply keep an empty
   pipeline and a null lastContactDays, and the dashboard degrades gracefully.
   Confirm the two endpoints/shapes on first live pull, the same way we did tags.
   ------------------------------------------------------------------ */
async function fetchJson(token, path){
  try{ const res=await fetch(`${NIMBLE_BASE}${path}`, { headers:{ Authorization:`Bearer ${token}` } });
    if(!res.ok) return null; return await res.json(); }catch(e){ return null; }
}
// most-recent activity date per contact id -> for lastContactDays
async function fetchActivityRecency(token, maxPages){
  const map={}; let page=1, pages=1;
  do{
    const data=await fetchJson(token, `/activities?per_page=30&page=${page}`);
    if(!data) break;
    const list=data.resources||data.activities||[];
    for(const act of list){
      const when=act.created||act.modified||act.timestamp||act.date;
      const ids=[].concat(act.contact_ids||act.contacts||act.related_contacts||[]);
      ids.forEach(id=>{ const k=(id&&id.id)||id; if(!k||!when)return; if(!map[k]||new Date(when)>new Date(map[k])) map[k]=when; });
    }
    pages=(data.meta&&(data.meta.pages||data.meta.total_pages))||pages; page++;
  } while(page<=pages && page<=(maxPages||15));
  return map;
}
// open deals grouped by the contact/company they belong to
async function fetchDeals(token, maxPages){
  const byContact={}; let page=1, pages=1;
  do{
    const data=await fetchJson(token, `/deals?per_page=30&page=${page}`);   //! confirm the deals endpoint on first pull
    if(!data) break;
    const list=data.resources||data.deals||[];
    for(const d of list){
      const cid=(d.contact_id)||(d.contact&&d.contact.id)||(d.related_contact&&d.related_contact.id)||null;
      const deal={ dealId:d.id, title:d.title||d.name||'', stage:(d.stage&&(d.stage.name||d.stage))||d.status||'',
        value:+((d.value&&d.value.amount)||d.value||d.amount||0)||0,
        probability:d.probability!=null?+d.probability:null, closeDate:d.close_date||d.expected_close_date||null,
        ageDays:d.created?Math.round((Date.now()-new Date(d.created))/864e5):null };
      (byContact[cid]=byContact[cid]||[]).push(deal);
    }
    pages=(data.meta&&(data.meta.pages||data.meta.total_pages))||pages; page++;
  } while(page<=pages && page<=(maxPages||40));
  return byContact;
}
module.exports.fetchActivityRecency = fetchActivityRecency;
module.exports.fetchDeals = fetchDeals;
