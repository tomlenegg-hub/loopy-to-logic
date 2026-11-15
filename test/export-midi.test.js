import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DUB, folderReader, loadFixture } from './helpers.js';
import { buildMixer } from '../src/lib/mixer.js';
import { findLanes, proposeTargets } from '../src/lib/automation.js';
import { exportInstrumentMidi, exportAutomationMidi } from '../src/lib/export-midi.js';
import { readSmf, PPQ } from '../src/lib/smf.js';

let files, auto, mixer;
beforeAll(async () => {
  const project = await loadFixture(DUB);
  const rd = folderReader(DUB);
  const lookups = { numaSounds: JSON.parse(fs.readFileSync('data/numa-sounds.json', 'utf8')) };
  mixer = buildMixer(project, rd, lookups);
  files = exportInstrumentMidi(project, mixer, rd);
  const targets = proposeTargets(findLanes(project, rd), mixer, JSON.parse(fs.readFileSync('data/automation-targets.json', 'utf8')));
  auto = exportAutomationMidi(project, mixer, rd, targets);
});

const noteOns = (trk) => trk.events.filter((e) => !e.meta && (e.bytes[0] & 0xf0) === 0x90 && e.bytes[2] > 0);
const noteOffs = (trk) => trk.events.filter((e) => !e.meta && (e.bytes[0] & 0xf0) === 0x80);

describe('instrument MIDI files', () => {
  const EXPECTED = { 'J6 Synth One A': 432, 'J6 Synth One B': 1050, 'J6 Synth One C': 2226, 'J6 Synth One D': 1054,
    'Numa Player': 276, 'DigiStix A': 1242, 'DigiStix B': 91, 'DigiStix C': 160 };
  it('produces one file per instrument', () => expect(files.map((f) => f.name).sort()).toEqual(Object.keys(EXPECTED).sort()));
  for (const [name, count] of Object.entries(EXPECTED)) {
    it(`${name}: ${count} notes survive a write/read round trip`, () => {
      const smf = readSmf(files.find((f) => f.name === name).bytes);
      expect(smf.ppq).toBe(PPQ);
      const trk = smf.tracks[1];
      expect(noteOns(trk)).toHaveLength(count);
      expect(noteOffs(trk)).toHaveLength(count);
    });
  }
  it('carries tempo 75 and 4/4 in the first track', () => {
    const smf = readSmf(files[0].bytes);
    const tempo = smf.tracks[0].events.find((e) => e.meta === 0x51).bytes;
    expect((tempo[0] << 16) | (tempo[1] << 8) | tempo[2]).toBe(800000);
    expect(smf.tracks[0].events.find((e) => e.meta === 0x58).bytes[0]).toBe(4);
  });
  it('DigiStix B plays one snare note on beats 2 and 4 of each bar (offset ticks = 1 and 3 beats)', () => {
    const smf = readSmf(files.find((f) => f.name === 'DigiStix B').bytes);
    const beats = new Set(noteOns(smf.tracks[1]).map((e) => Math.round(((e.tick / PPQ) % 4) * 4) / 4));
    expect([...beats].sort()).toEqual([1, 3]);
  });
});

describe('automation MIDI file', () => {
  it('has a tempo track plus one track per lane on CC20 upwards, never CC0', () => {
    const smf = readSmf(auto.bytes);
    expect(smf.tracks).toHaveLength(1 + 5);
    const ccs = smf.tracks.slice(1).map((t) => new Set(t.events.filter((e) => !e.meta).map((e) => e.bytes[1])));
    ccs.forEach((s, i) => expect([...s]).toEqual([20 + i]));
  });
  it('each lane uses its own channel', () => {
    const smf = readSmf(auto.bytes);
    const chans = smf.tracks.slice(1).map((t) => t.events.find((e) => !e.meta).bytes[0] & 15);
    expect(chans).toEqual([0, 1, 2, 3, 4]);
  });
  it('Bass Distortion lane ends on 38 and Bass Turnado on 0', () => {
    const smf = readSmf(auto.bytes);
    const last = (title) => {
      const t = smf.tracks.find((x) => x.name.startsWith(title));
      return t.events.filter((e) => !e.meta).at(-1).bytes[2];
    };
    expect(last('Bass Distortion')).toBe(38);
    expect(last('Bass Turnado')).toBe(0);
  });
  it('mapping reports confirmed targets', () => {
    const m = auto.mapping.find((x) => x.lane.startsWith('Bass Distortion'));
    expect(m.target).toBe('Bass nofx → Bus D');
    expect(m.cc).toBeGreaterThanOrEqual(20);
  });
});

describe('MIDI loop pitch (canvas transpose)', () => {
  const lowest = (name) => Math.min(...noteOns(readSmf(files.find((f) => f.name === name).bytes).tracks[1]).map((e) => e.bytes[1]));
  it('J6 C and D (loop pitch +12) are transposed up an octave relative to J6 B (pitch 0)', () => {
    // the same source loop feeds J6 B, C and D
    expect(lowest('J6 Synth One C')).toBe(lowest('J6 Synth One B') + 12);
    expect(lowest('J6 Synth One D')).toBe(lowest('J6 Synth One B') + 12);
  });
});
