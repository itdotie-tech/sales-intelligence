/* TEMPORARY Autotask data-warehouse connection test.
   Read-only. Connects with tedious (pure-JS SQL driver), lists the tables it
   can see, and returns either that list or the exact error. Delete this whole
   folder once we have what we need. It does not touch getSource or the
   dashboard in any way. */
const { Connection, Request } = require('tedious');

function cfg(){
  const need = ['AUTOTASK_SQL_SERVER','AUTOTASK_SQL_DATABASE','AUTOTASK_SQL_USER','AUTOTASK_SQL_PASSWORD'];
  const missing = need.filter(k => !process.env[k]);
  if (missing.length) throw new Error('Missing app settings: ' + missing.join(', '));
  return {
    server: process.env.AUTOTASK_SQL_SERVER,
    authentication: { type: 'default', options: {
      userName: process.env.AUTOTASK_SQL_USER,
      password: process.env.AUTOTASK_SQL_PASSWORD
    }},
    options: {
      database: process.env.AUTOTASK_SQL_DATABASE,
      port: 1433,
      encrypt: true,
      trustServerCertificate: true,
      connectTimeout: 20000,
      requestTimeout: 20000,
      rowCollectionOnRequestCompletion: true
    }
  };
}

function runQuery(sql){
  return new Promise((resolve, reject) => {
    let conn;
    try { conn = new Connection(cfg()); }
    catch (e) { return reject(e); }
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; try{ conn.close(); }catch(_){} fn(arg); } };
    conn.on('connect', err => {
      if (err) return done(reject, err);
      const rows = [];
      const req = new Request(sql, (rErr, rowCount, allRows) => {
        if (rErr) return done(reject, rErr);
        (allRows||[]).forEach(cols => {
          const o = {}; cols.forEach(c => { o[c.metadata.colName] = c.value; }); rows.push(o);
        });
        done(resolve, rows);
      });
      conn.execSql(req);
    });
    conn.on('error', err => done(reject, err));
    try { conn.connect(); } catch (e) { done(reject, e); }
  });
}

module.exports = async function (context, req) {
  const started = Date.now();
  try {
    const tables = await runQuery(
      "SELECT TOP 300 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES " +
      "WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_NAME"
    );
    const names = tables.map(t => (t.TABLE_SCHEMA ? t.TABLE_SCHEMA + '.' : '') + t.TABLE_NAME);
    const interesting = names.filter(n => /device|product|asset|config|item|company|account|ticket|contract/i.test(n));
    context.res = {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        elapsedMs: Date.now() - started,
        tableCount: names.length,
        likelyDeviceTables: interesting,
        firstTables: names.slice(0, 60)
      }, null, 2)
    };
  } catch (e) {
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        elapsedMs: Date.now() - started,
        error: (e && e.message) || String(e),
        code: (e && (e.code || e.number)) || null
      }, null, 2)
    };
  }
};
