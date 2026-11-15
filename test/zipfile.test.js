import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { openZip, findProjectRoot } from '../src/app/zipfile.js';

const ZIP = path.join(import.meta.dirname, '..', 'fixtures', 'raw', 'Adabadaba_Dub.zip');
const blob = () => new Blob([fs.readFileSync(ZIP)]);

describe('zip reader', () => {
  it('finds the project root and ignores __MACOSX', async () => {
    const z = await openZip(blob());
    expect(findProjectRoot(z.names)).toEqual({ prefix: 'Adabadaba Dub.lpproj/', name: 'Adabadaba Dub' });
  });
  it('inflates a deflated entry to its declared size and a valid SQLite header', async () => {
    const z = await openZip(blob());
    const db = await z.read('Adabadaba Dub.lpproj/Project.sqlite');
    expect(db.length).toBe(z.size('Adabadaba Dub.lpproj/Project.sqlite'));
    expect(new TextDecoder().decode(db.subarray(0, 15))).toBe('SQLite format 3');
  });
  it('reads a large AIFF identically to the unzipped fixture', async () => {
    const z = await openZip(blob());
    const name = 'Adabadaba Dub.lpproj/Resources/E5F849B5-7F0B-4906-AE31-7C8ACC0939E7.aiff';
    const got = await z.read(name);
    const want = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'dub', 'Adabadaba Dub.lpproj', 'Resources', 'E5F849B5-7F0B-4906-AE31-7C8ACC0939E7.aiff'));
    expect(Buffer.compare(Buffer.from(got), want)).toBe(0);
  });
  it('returns undefined for a missing entry and rejects a non-zip', async () => {
    const z = await openZip(blob());
    expect(await z.read('nope')).toBeUndefined();
    await expect(openZip(new Blob([new Uint8Array(100)]))).rejects.toThrow(/zip/);
  });
});
