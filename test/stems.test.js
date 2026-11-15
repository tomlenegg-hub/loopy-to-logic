import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DUB, folderReader, loadFixture } from './helpers.js';
import { buildMixer } from '../src/lib/mixer.js';
import { planStems, renderStemToBytes } from '../src/lib/stems.js';
import { parseAiffHeader, decodeAiff } from '../src/lib/audio.js';

let project, mixer, rd, stems;
beforeAll(async () => {
  project = await loadFixture(DUB);
  rd = folderReader(DUB);
  mixer = buildMixer(project, rd, { numaSounds: JSON.parse(fs.readFileSync('data/numa-sounds.json', 'utf8')) });
  stems = planStems(project, mixer);
});

const SR = 44100;
const frameOfBeat = (b) => Math.round(b * 0.8 * SR);
const s24 = (u8, p) => ((u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16)) << 8) >> 8;

describe('stem plan', () => {
  it('skips Bass main (unused) and Blue Stabs (superseded) by default', () => {
    expect(stems.map((s) => s.filename).sort()).toEqual(['Lime – Bass2.wav', 'Violet – Bass2.wav', 'Yellow – Bass nofx.wav']);
  });
  it('can include them on request', () => {
    const all = planStems(project, mixer, { includeSuperseded: true, includeUnused: true });
    expect(all).toHaveLength(5);
    const main = all.find((x) => x.label === 'Bass main');
    expect(main.endBeat).toBe(16); // unused loop: a single pass from bar 1
    expect(Number.isFinite(all.find((x) => x.colour === 'Blue').endBeat)).toBe(true);
  });
  it('stems run from bar 1 to the end of the last placement', () => {
    expect(stems.find((s) => s.colour === 'Yellow').endBeat).toBe(432);
  });
});

describe('stem rendering', () => {
  it('Yellow: header describes 24-bit/44.1k stereo covering 432 beats; silence before the first entry at beat 96', async () => {
    const y = stems.find((s) => s.colour === 'Yellow');
    // Render a slice around the first entry so the test stays fast
    const range = { startBeat: 94, endBeat: 98 };
    const wav = await renderStemToBytes(y, rd, { range });
    const dv = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint32(24, true)).toBe(SR);
    expect(dv.getUint16(34, true)).toBe(24);
    expect(dv.getUint32(40, true)).toBe((frameOfBeat(98) - frameOfBeat(94)) * 6);
    const data = 44;
    // beats 94–96 silent
    const silentFrames = frameOfBeat(96) - frameOfBeat(94);
    let nonzero = 0;
    for (let i = 0; i < silentFrames * 2; i++) if (s24(wav, data + i * 3) !== 0) nonzero++;
    expect(nonzero).toBe(0);
    // first audible frames equal the source loop (offset 0, gain 1)
    const bytes = rd('E5F849B5-7F0B-4906-AE31-7C8ACC0939E7.aiff');
    const loop = decodeAiff(bytes, parseAiffHeader(bytes), 0, 2000);
    for (const i of [0, 500, 1500]) {
      const got = s24(wav, data + (silentFrames + i) * 6) / 8388608;
      expect(got).toBeCloseTo(loop.left[i], 5);
    }
  });

  it('Lime: octave-up loop keeps its length and has a sensible level', async () => {
    const lime = stems.find((s) => s.colour === 'Lime');
    const stats = {};
    const wav = await renderStemToBytes(lime, rd, { range: { startBeat: 160, endBeat: 176 }, stats });
    expect(stats.shifted).toEqual(['Bass2 +12']);
    const frames = (wav.length - 44) / 6;
    expect(frames).toBe(frameOfBeat(176) - frameOfBeat(160));
    let sum = 0;
    for (let i = 0; i < frames; i += 7) { const v = s24(wav, 44 + i * 6) / 8388608; sum += v * v; }
    const rms = Math.sqrt(sum / (frames / 7));
    expect(rms).toBeGreaterThan(0.01);
    expect(rms).toBeLessThan(0.5);
  });

  it('Violet mixes its two Bass2 loops (−12 and unshifted) without clipping at their placements', async () => {
    const v = stems.find((s) => s.colour === 'Violet');
    const stats = {};
    await renderStemToBytes(v, rd, { range: { startBeat: 190, endBeat: 210 }, stats });
    expect(stats.shifted).toEqual(['Bass2 -12']);
    expect(stats.clipped).toBe(0);
  });
});
