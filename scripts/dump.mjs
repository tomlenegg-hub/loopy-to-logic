import fs from 'fs'; import { loadProject } from '../src/lib/project.js';
const p = await loadProject(fs.readFileSync(process.argv[2]));
const types = process.argv.slice(3);
for (const o of p.objects.values()) if (types.includes(o.type)) {
  const s = JSON.stringify(o.data, (k,v)=> typeof v==='string' && v.length>60 ? v.slice(0,40)+`…(${v.length})` : v);
  console.log(o.id, o.type, s.slice(0, 700));
}
