import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { analyse, runExport, zipFiles, manifestFor } from '../src/app/engine.js';
import { openZip } from '../src/app/zipfile.js';

const raw = (n) => new Blob([fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'raw', n))]);
let a;
beforeAll(async () => { a = await analyse(raw('Adabadaba_Dub.zip'), raw('Logic_Migration_Project.zip')); }, 60000);

describe('engine on zipped fixtures', () => {
  it('summarises the project', () => {
    expect(a.summary).toMatchObject({ name: 'Adabadaba Dub', tempo: 75, beatsPerBar: 4, effects: 23, buses: 7, lanes: 5, instruments: 8, stems: 3 });
    expect(a.summary.bars).toBeGreaterThan(100);
  });
  it('manifest from a zipped project matches the folder-based one', () => {
    const md = manifestFor(a);
    expect(md).toContain('23 effect instances in total.');
    expect(md).toContain('Mix: 50% → 89%');
  });
  it('exports everything and bundles it into a readable zip', async () => {
    const progress = [];
    const files = await runExport(a, { stems: true, midi: true, automation: true, manifest: true }, (p) => progress.push(p.fraction));
    expect(files.filter((f) => f.folder === 'MIDI')).toHaveLength(8);
    expect(files.filter((f) => f.folder === 'Audio').map((f) => f.name).sort()).toEqual(['Lime – Bass2.wav', 'Violet – Bass2.wav', 'Yellow – Bass nofx.wav']);
    expect(files.find((f) => f.folder === 'Automation')).toBeTruthy();
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1] - 1e-9)).toBe(true);
    const manifest = files.find((f) => f.name.endsWith('effects manifest.md'));
    expect(await manifest.blob.text()).toContain('In the MIDI file');
    const root = 'Adabadaba Dub – Logic migration';
    const zip = await openZip(await zipFiles(files, () => {}, root));
    expect(zip.names).toContain(`${root}/Audio/Yellow – Bass nofx.wav`);
    expect(zip.names).toContain(`${root}/MIDI/J6 Synth One A.mid`);
    expect(zip.names).toContain(`${root}/Adabadaba Dub – effects manifest.md`);
    expect(zip.names).toContain(`${root}/Automation/Automation lanes.mid`);
    expect(zip.size(`${root}/Audio/Yellow – Bass nofx.wav`)).toBe(files.find((f) => f.name === 'Yellow – Bass nofx.wav').size);
  }, 120000);
  it('can export MIDI only without touching audio', async () => {
    const files = await runExport(a, { midi: true }, () => {});
    expect(files.every((f) => f.folder === 'MIDI')).toBe(true);
  });
});
