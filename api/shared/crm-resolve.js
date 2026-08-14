/* Nimble tag -> active/dormant + account manager. */
const AM_ROSTER = {
  DF:'David Flood', DG:'David Groark', DMcD:'David McDonald', DOC:"Derek O'Callaghan",
  EB:'Emil Badea', EJ:'Eoghan Johnson', SC:'Simon Collins', MD:'Michael Daly',
};
const AM_ALIASES = { 'emil bidea':'Emil Badea', 'emil badea':'Emil Badea', "derek ocallaghan":"Derek O'Callaghan" };
function canonAM(name){ if(!name) return ''; const k=String(name).toLowerCase().replace(/[^a-z' ]/g,'').replace(/\s+/g,' ').trim(); return AM_ALIASES[k]||name; }
function classifyTag(tag){
  if(!tag || !/accounts?/i.test(tag)) return null;
  const dormant = /\(\s*d\s*\)/i.test(tag);
  const codes = Object.keys(AM_ROSTER).sort((a,b)=>b.length-a.length);
  for(const code of codes){
    const re = new RegExp('(^|[^a-z])'+code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^a-z]|$)','i');
    if(re.test(tag)) return { code, am: AM_ROSTER[code], dormant };
  }
  return null;
}
function resolveAccount(tags){
  const active=[], dormant=[];
  (tags||[]).forEach(t=>{ const c=classifyTag(t); if(!c) return; (c.dormant?dormant:active).push(c); });
  if(active.length) return { active:true, dormant:false, amCode:active[0].code, am:active[0].am };
  if(dormant.length) return { active:false, dormant:true, amCode:dormant[0].code, am:dormant[0].am };
  return { active:false, dormant:false, amCode:null, am:'' };
}
module.exports = { AM_ROSTER, canonAM, classifyTag, resolveAccount };
