import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Zip, ZipPassThrough, zipSync } from 'fflate';
import { openProjectZip, analyse, clearCache, NeedsChoiceError, SameFileError, manifestFor } from '../src/app/engine.js';
import { findProjects } from '../src/app/zipfile.js';

const fx = (...p) => path.join(import.meta.dirname, '..', 'fixtures', ...p);
const SQLITE = new Uint8Array(fs.readFileSync(fx('dub', 'Adabadaba Dub.lpproj', 'Project.sqlite')));
const rawZip = (n) => new File([fs.readFileSync(fx('raw', n))], n, { lastModified: 1 });
const makeZip = (entries, name = 'test.zip') => new File(
  [zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v, { level: 0 }]])))], name, { lastModified: 2 });
const tiny = new Uint8Array([1, 2, 3]);

beforeEach(() => clearCache());

describe('item 1: project root detection', () => {
  it('folder zipped normally', async () => {
    const p = await openProjectZip(makeZip({ 'My Song.lpproj/Project.sqlite': SQLITE, 'My Song.lpproj/Resources/a.moduleState': tiny }));
    expect(p.root).toEqual({ prefix: 'My Song.lpproj/', name: 'My Song' });
    expect(p.project.objects.size).toBeGreaterThan(100);
    expect(p.cache.has('a.moduleState')).toBe(true);
  });
  it('folder contents zipped without the folder (Project.sqlite at the top level)', async () => {
    const p = await openProjectZip(makeZip({ 'Project.sqlite': SQLITE, 'Resources/a.moduleState': tiny }, 'Flat Song.zip'));
    expect(p.root).toEqual({ prefix: '', name: 'Flat Song' });
    expect(p.cache.has('a.moduleState')).toBe(true); // Resources resolved relative to the detected root
  });
  it('folder nested one level deeper, and not named .lpproj', async () => {
    const p = await openProjectZip(makeZip({ 'Wrapper/Renamed Folder/Project.sqlite': SQLITE, 'Wrapper/Renamed Folder/Resources/b.lpmidi': tiny }));
    expect(p.root).toEqual({ prefix: 'Wrapper/Renamed Folder/', name: 'Renamed Folder' });
    expect(p.cache.has('b.lpmidi')).toBe(true);
  });
  it('ignores __MACOSX and dot-files', () => {
    const names = ['__MACOSX/X.lpproj/Project.sqlite', '.hidden/Project.sqlite', 'Real.lpproj/Project.sqlite', 'Real.lpproj/._Project.sqlite'];
    expect(findProjects(names)).toEqual([{ prefix: 'Real.lpproj/', name: 'Real' }]);
  });
  it('a zip with no project fails with the first 20 entries listed', async () => {
    const entries = {};
    for (let i = 1; i <= 25; i++) entries[`stuff/file${String(i).padStart(2, '0')}.txt`] = tiny;
    const err = await openProjectZip(makeZip(entries)).catch((e) => e);
    expect(err.message).toMatch(/^Project: No Loopy project found/);
    expect(err.message).toContain('stuff/file20.txt');
    expect(err.message).not.toContain('stuff/file21.txt');
  });
  it('several projects: asks for a choice, then opens the chosen one', async () => {
    const zip = makeZip({ 'A.lpproj/Project.sqlite': SQLITE, 'B.lpproj/Project.sqlite': SQLITE });
    const err = await openProjectZip(zip).catch((e) => e);
    expect(err).toBeInstanceOf(NeedsChoiceError);
    expect(err.candidates.map((c) => c.name)).toEqual(['A', 'B']);
    const p = await openProjectZip(zip, { root: 'B.lpproj/' });
    expect(p.root.name).toBe('B');
  });
});

function counting(file) {
  const stats = { bytes: 0, slices: 0 };
  return {
    stats,
    blob: {
      name: file.name, size: file.size, lastModified: file.lastModified,
      slice: (a, b) => { stats.slices++; stats.bytes += (b ?? file.size) - (a ?? 0); return file.slice(a, b); },
    },
  };
}

describe('item 2: memory, caching and errors', () => {
  it('adding a baseline never re-reads the main project', async () => {
    const main = counting(rawZip('Adabadaba_Dub.zip'));
    await analyse(main.blob);
    const before = { ...main.stats };
    const a = await analyse(main.blob, rawZip('Logic_Migration_Project.zip'));
    expect(main.stats).toEqual(before);
    expect(a.baseline).toBeTruthy();
    await analyse(main.blob, null); // and removing it
    expect(main.stats).toEqual(before);
  });

  it('a 250 MB+ project zip is read lazily, then a baseline is added', async () => {
    const parts = [];
    const z = new Zip((err, chunk) => { if (err) throw err; parts.push(chunk); });
    const head = new ZipPassThrough('Big.lpproj/Project.sqlite');
    z.add(head); head.push(SQLITE, true);
    const big = new ZipPassThrough('Big.lpproj/Resources/loop.aiff');
    z.add(big);
    const zeros = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < 32; i++) big.push(zeros, i === 31);
    z.end();
    const file = new File(parts, 'Big.zip', { lastModified: 3 });
    expect(file.size).toBeGreaterThan(250 * 1024 * 1024);
    const c = counting(file);
    const a1 = await analyse(c.blob);
    expect(a1.summary.effects).toBe(23);
    expect(c.stats.bytes).toBeLessThan(2 * 1024 * 1024); // never the audio, never the whole zip
    const before = { ...c.stats };
    const a2 = await analyse(c.blob, rawZip('Logic_Migration_Project.zip'));
    expect(a2.baseline).toBeTruthy();
    expect(c.stats).toEqual(before);
  }, 120000);

  it('refuses the same file in both inputs', async () => {
    const f = rawZip('Adabadaba_Dub.zip');
    await expect(analyse(f, f)).rejects.toBeInstanceOf(SameFileError);
    await expect(analyse(rawZip('Adabadaba_Dub.zip'), rawZip('Adabadaba_Dub.zip'))).rejects.toThrow(/same file/);
  });

  it('names the input and the real underlying error', async () => {
    const bad = new File([new Uint8Array(500)], 'junk.zip', { lastModified: 4 });
    await expect(analyse(rawZip('Adabadaba_Dub.zip'), bad)).rejects.toThrow(/^Baseline project: .*zip/);
    await expect(analyse(bad)).rejects.toThrow(/^Project: .*zip/);
  });
});

describe('items 3 and 4: no arrangement, counts', () => {
  it('the baseline loaded as the main project shows no NaN or undefined anywhere', async () => {
    const a = await analyse(rawZip('Logic_Migration_Project.zip'));
    expect(a.summary.lengthText).toBe('No arrangement');
    expect(a.summary.tempoText).toBe('120 bpm');
    expect(a.summary.warnings.join(' ')).toMatch(/assuming 120 bpm/);
    expect(a.summary.warnings.join(' ')).toMatch(/no arrangement/);
    const text = JSON.stringify(a.summary) + manifestFor(a);
    expect(text).not.toMatch(/NaN|undefined|Infinity|\bnull\b/);
    // with no arrangement, "unused loop" warnings would be noise for every loop
    expect(a.summary.warnings.filter((w) => /not used in the arrangement/.test(w))).toEqual([]);
  });
  it('exact counts: Adabadaba Dub 23 effects and 7 buses; baseline 14 effects, 0 buses, 6 instruments', async () => {
    const dub = await analyse(rawZip('Adabadaba_Dub.zip'));
    expect(dub.summary).toMatchObject({ effects: 23, buses: 7, instruments: 8 });
    const base = await analyse(rawZip('Logic_Migration_Project.zip'));
    // 14 Effect objects exist in the file, all on colour groups; the audio input is not an instrument
    expect(base.summary).toMatchObject({ effects: 14, buses: 0, instruments: 6 });
    expect(base.proj.project.all('Effect')).toHaveLength(14);
  });
});
