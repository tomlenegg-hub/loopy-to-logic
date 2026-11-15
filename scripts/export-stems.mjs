import fs from 'fs';
import { DUB, folderReader, loadFixture } from '../test/helpers.js';
import { buildMixer } from '../src/lib/mixer.js';
import { planStems, renderStem } from '../src/lib/stems.js';
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const p = await loadFixture(DUB), rd = folderReader(DUB);
const m = buildMixer(p, rd, {});
for (const stem of planStems(p, m)) {
  const t0 = performance.now(); const stats = {}; const fd = fs.openSync(`${out}/${stem.filename}`, 'w');
  for await (const c of renderStem(stem, rd, { stats })) fs.writeSync(fd, c);
  fs.closeSync(fd);
  console.log(stem.filename, `${stem.endBeat} beats`, `${((performance.now()-t0)/1000).toFixed(1)}s`, `${(fs.statSync(`${out}/${stem.filename}`).size/1e6).toFixed(0)} MB`, 'peak', stats.peak.toFixed(3), 'clipped', stats.clipped, 'shifted', stats.shifted.join(','), `rss ${(process.memoryUsage().rss/1e6).toFixed(0)} MB`);
}
