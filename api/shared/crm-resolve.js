/* ============================================================
   CRM (Nimble) resolution layer
   - active accounts are designated by the eight "<code> Accounts" tags
   - a "(D)" on an otherwise-matching tag means dormant, ignore
   - the tag also carries the account manager
   - account-manager names are normalised to a canonical roster so a
     spelling difference between CRM and NetSuite cannot split one
     manager into two
   ============================================================ */

// canonical roster: code -> the one true spelling used everywhere in the app
const AM_ROSTER = {
  DF:  'David Flood',
  DG:  'David Groark',
  DMcD:'David McDonald',
  DOC: "Derek O'Callaghan",
  EB:  'Emil Badea',            // NetSuite spelling wins; "Bidea" is an alias below
  EJ:  'Eoghan Johnson',
  SC:  'Simon Collins',
  MD:  'Michael Daly',
};
// spelling variants seen in either system -> canonical name
const AM_ALIASES = {
  'emil bidea':'Emil Badea', 'emil badea':'Emil Badea',
  'derek ocallaghan':"Derek O'Callaghan", "derek o'callaghan":"Derek O'Callaghan",
  'david mcdonald':'David McDonald', 'david macdonald':'David McDonald',
};
function canonAM(name){
  if(!name) return '';
  const k=String(name).toLowerCase().replace(/[^a-z' ]/g,'').replace(/\s+/g,' ').trim();
  return AM_ALIASES[k] || name;
}

// Is this tag one of the account tags? Returns {code, am, dormant} or null.
// Robust to "(D)" appearing anywhere and to Account/Accounts singular/plural.
function classifyTag(tag){
  if(!tag || !/accounts?/i.test(tag)) return null;         // must be an "Accounts" tag
  const dormant = /\(\s*d\s*\)/i.test(tag);
  // longest codes first so DMcD/DOC are tried before D-anything
  const codes = Object.keys(AM_ROSTER).sort((a,b)=>b.length-a.length);
  for(const code of codes){
    const re = new RegExp('(^|[^a-z])'+code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^a-z]|$)','i');
    if(re.test(tag)) return { code, am: AM_ROSTER[code], dormant };
  }
  return null;
}

// Resolve one CRM account from its tags.
function resolveAccount(tags){
  const active=[], dormant=[];
  (tags||[]).forEach(t=>{ const c=classifyTag(t); if(!c) return; (c.dormant?dormant:active).push(c); });
  if(active.length) return { active:true,  dormant:false, amCode:active[0].code, am:active[0].am };
  if(dormant.length)return { active:false, dormant:true,  amCode:dormant[0].code, am:dormant[0].am };
  return { active:false, dormant:false, amCode:null, am:'' };  // in CRM but not a tagged account: prospect/pipeline
}

// NetSuite wins for account manager; a saved human correction wins over both.
// Flags a mismatch when NetSuite and CRM both name a manager and they differ.
function reconcileAM(netsuiteAM, crmAM, override){
  const ns=canonAM(netsuiteAM), crm=canonAM(crmAM);
  if(override) return { am:canonAM(override), source:'corrected', mismatch:false };
  if(ns && crm && ns!==crm) return { am:ns, source:'netsuite', mismatch:true, crmSays:crm };
  if(ns)  return { am:ns,  source:'netsuite', mismatch:false };
  if(crm) return { am:crm, source:'crm',      mismatch:false };   // fills NetSuite blanks from the tag
  return { am:'Unassigned', source:'none', mismatch:false };
}

module.exports = { AM_ROSTER, canonAM, classifyTag, resolveAccount, reconcileAM };

/* ------------------------------------------------------------
   Client status combines the CRM signal with NetSuite revenue.
   billing   : tagged active AND has NetSuite revenue  (normal client)
   migrating : tagged active, no NetSuite revenue yet  (acquired co., revenue next month)
   untagged  : billing in NetSuite but no active CRM tag (data-quality: should be tagged)
   dormantBilling : dormant in CRM yet still billing   (winding down or tag stale)
   dormant   : dormant tag, no revenue                 (ignore from active base)
   prospect  : in CRM pipeline only, not a client
   A client counts in the active base if it bills OR is a tagged active account.
   ------------------------------------------------------------ */
function resolveStatus(crmRes, hasRevenue){
  crmRes = crmRes || { active:false, dormant:false, amCode:null, am:'' };
  let status;
  if(crmRes.active)            status = hasRevenue ? 'billing'  : 'migrating';
  else if(crmRes.dormant)      status = hasRevenue ? 'dormantBilling' : 'dormant';
  else                         status = hasRevenue ? 'untagged' : 'prospect';
  const active = hasRevenue || crmRes.active;                 // in the operating base
  const revenuePending = status==='migrating';               // record, but no booked MRR yet
  const needsTag = status==='untagged';                      // billing but not tagged in CRM
  return { status, active, revenuePending, needsTag, amCode:crmRes.amCode||null, am:crmRes.am||'' };
}
module.exports.resolveStatus = resolveStatus;
