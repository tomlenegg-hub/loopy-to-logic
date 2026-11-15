import fs from 'fs'; import initSqlJs from 'sql.js';
const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync(process.argv[2]));
const rows = db.exec('select id,type,contents from objects')[0].values;
const counts = {}; for (const r of rows) counts[r[1]] = (counts[r[1]]||0)+1;
console.log(rows.length, counts);
console.log(db.exec('select * from meta')[0]?.values.slice(0,10));
const want = process.argv.slice(3);
for (const r of rows) if (want.includes(r[1])) {
  let c = r[2]; try { c = Buffer.from(c).toString('utf8'); } catch {}
  console.log(r[0], r[1], c.slice(0, 1500));
}
