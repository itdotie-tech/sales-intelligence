/* NetSuite puller — Token-Based Auth (OAuth 1.0a, HMAC-SHA256) + SuiteQL.
   Returns invoice lines with the FULL account path (needed for revenue scope
   and to match the service mapping). Zero external dependencies. */
const crypto = require('crypto');
function creds(){
  const account=process.env.NETSUITE_ACCOUNT_ID;
  const missing=['NETSUITE_ACCOUNT_ID','NETSUITE_CONSUMER_KEY','NETSUITE_CONSUMER_SECRET','NETSUITE_TOKEN_ID','NETSUITE_TOKEN_SECRET'].filter(k=>!process.env[k]);
  if(missing.length) throw new Error('Missing NetSuite settings: '+missing.join(', '));
  return { account, realm:String(account).toUpperCase(), host:String(account).toLowerCase().replace(/_/g,'-'),
    consumerKey:process.env.NETSUITE_CONSUMER_KEY, consumerSecret:process.env.NETSUITE_CONSUMER_SECRET,
    tokenId:process.env.NETSUITE_TOKEN_ID, tokenSecret:process.env.NETSUITE_TOKEN_SECRET };
}
function pct(s){ return encodeURIComponent(String(s)).replace(/[!*'()]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()); }
function authHeader(method,url,c){
  const o={ oauth_consumer_key:c.consumerKey, oauth_token:c.tokenId, oauth_signature_method:'HMAC-SHA256',
    oauth_timestamp:Math.floor(Date.now()/1000).toString(), oauth_nonce:crypto.randomBytes(16).toString('hex'), oauth_version:'1.0' };
  const u=new URL(url); const all={...o}; u.searchParams.forEach((v,k)=>{all[k]=v;});
  const baseUrl=`${u.protocol}//${u.host}${u.pathname}`;
  const paramStr=Object.keys(all).sort().map(k=>`${pct(k)}=${pct(all[k])}`).join('&');
  const baseString=[method.toUpperCase(),pct(baseUrl),pct(paramStr)].join('&');
  const signingKey=`${pct(c.consumerSecret)}&${pct(c.tokenSecret)}`;
  o.oauth_signature=crypto.createHmac('sha256',signingKey).update(baseString).digest('base64');
  return 'OAuth realm="'+c.realm+'", '+Object.keys(o).sort().map(k=>`${pct(k)}="${pct(o[k])}"`).join(', ');
}
async function suiteql(c,q,limit,offset){
  const url=`https://${c.host}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;
  const res=await fetch(url,{method:'POST',headers:{'Authorization':authHeader('POST',url,c),'Content-Type':'application/json','Prefer':'transient'},body:JSON.stringify({q})});
  const text=await res.text();
  if(!res.ok) throw new Error(`NetSuite ${res.status}: ${text.slice(0,400)}`);
  try { return JSON.parse(text); } catch(e){ throw new Error('NetSuite returned non-JSON: '+text.slice(0,200)); }
}
async function getNetsuiteData(opts){
  opts=opts||{}; const c=creds();
  const start=process.env.NETSUITE_START_DATE||'2024-01-01';
  const from=opts.from||start, to=opts.to||null;
  // acc.fullname gives the full account path ("Sales Recurring : Backup : ..."),
  // which the dashboard needs both to scope revenue and to match the mapping.
  const paged = opts.page!=null && opts.page>=0;
  const dir = (paged||opts.full===true) ? 'ASC' : 'DESC';
  const q=`SELECT TO_CHAR(t.trandate,'YYYY-MM-DD') AS date, t.tranid AS invoice, BUILTIN.DF(t.entity) AS customer, BUILTIN.DF(tl.item) AS item, BUILTIN.DF(tl.account) AS account, BUILTIN.DF(tl.class) AS class, tl.netamount AS amount, tl.quantity AS quantity FROM transaction t, transactionline tl WHERE tl.transaction = t.id AND t.type = 'CustInvc' AND tl.mainline = 'F' AND tl.taxline = 'F' AND t.trandate >= TO_DATE('${from}','YYYY-MM-DD') ${to?"AND t.trandate < TO_DATE('"+to+"','YYYY-MM-DD')":''} ORDER BY t.trandate ${dir}, t.id`;
  const map=r=>({ date:r.date, invoice:r.invoice, customer:r.customer, item:r.item, account:r.account, class:r.class, amount:+r.amount||0, quantity:+r.quantity||0 });
  if(paged){
    // one page (1000 rows) at a time — the dashboard loops these, so no single request can time out
    const limit=1000, offset=opts.page*limit;
    const data=await suiteql(c,q,limit,offset);
    const rows=(data.items||[]).map(map);
    return { source:'netsuite', mode:'page', page:opts.page, rows, hasMore:!!data.hasMore, meta:{from:start} };
  }
  // default: fast sample of the 50 most recent lines, for a quick connection check
  const data=await suiteql(c,q.replace('ORDER BY t.trandate ASC','ORDER BY t.trandate DESC'),50,0);
  const rows=(data.items||[]).map(map);
  return { generated:new Date().toISOString(), source:'netsuite', mode:'sample', rows, meta:{count:rows.length, from:start} };
}
module.exports = { getNetsuiteData };
