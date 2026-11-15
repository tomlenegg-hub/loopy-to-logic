import fs from 'fs';
import { DUB, folderReader, loadFixture } from '../test/helpers.js';
import { buildMixer } from '../src/lib/mixer.js'; import { findLanes, proposeTargets } from '../src/lib/automation.js';
import { exportInstrumentMidi, exportAutomationMidi } from '../src/lib/export-midi.js';
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const p = await loadFixture(DUB), rd = folderReader(DUB);
const lookups = { numaSounds: JSON.parse(fs.readFileSync('data/numa-sounds.json','utf8')) };
const m = buildMixer(p, rd, lookups);
for (const f of exportInstrumentMidi(p, m, rd)) { fs.writeFileSync(`${out}/${f.filename}`, f.bytes); console.log(f.filename, f.noteCount); }
const a = exportAutomationMidi(p, m, rd, proposeTargets(findLanes(p, rd), m, JSON.parse(fs.readFileSync('data/automation-targets.json','utf8'))));
fs.writeFileSync(`${out}/${a.filename}`, a.bytes); console.log(a.filename, JSON.stringify(a.mapping));
