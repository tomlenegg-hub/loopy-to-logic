import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DUB, folderReader, loadFixture } from './helpers.js';
import { buildMixer } from '../src/lib/mixer.js';

let m;
beforeAll(async () => {
  const project = await loadFixture(DUB);
  const numaSounds = JSON.parse(fs.readFileSync('data/numa-sounds.json', 'utf8'));
  m = buildMixer(project, folderReader(DUB), { numaSounds });
});

const allEffects = () => [
  ...m.instruments.flatMap((i) => i.effects),
  ...m.groups.flatMap((g) => g.effects),
  ...m.buses.flatMap((b) => b.effects),
  ...m.master.effects,
];

describe('mixer (acceptance)', () => {
  it('has 23 effect instances', () => expect(allEffects().length).toBe(23));
  it('has 7 buses A–G', () => expect(m.buses.map((b) => b.letter)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']));
  it('master chain is AudioScope then RoughRider3, master gain ≈ 0.335', () => {
    expect(m.master.effects.map((e) => e.title)).toEqual(['AudioScope', 'RoughRider3']);
    expect(m.master.effects[1].preset).toBe('03 – Just A Bit Off The Top');
    expect(m.master.effects[1].position).toBe('Post');
    expect(m.master.gain).toBeCloseTo(0.335, 3);
  });
  it('Bus D is Kombinat4 "22 – MXR Through The Wall"', () => {
    const d = m.buses.find((b) => b.letter === 'D');
    expect(d.effects[0].title).toBe('Kombinat4');
    expect(d.effects[0].preset).toBe('22 – MXR Through The Wall');
  });
  it('Bass nofx sends 0.296875 to D and 0 to E', () => {
    const g = m.groups.find((x) => x.colour === 'Yellow');
    expect(g.sends.find((s) => s.bus === 'D').amount).toBeCloseTo(0.296875, 6);
    expect(g.sends.find((s) => s.bus === 'E').amount).toBe(0);
  });
  it('Bus E is Turnado with the eight expected slots', () => {
    const e = m.buses.find((b) => b.letter === 'E').effects[0];
    expect(e.turnado.strings.slice(0, 8).map((s) => s.text)).toEqual(
      ['Ventilator', 'Phaser', 'FastStops', 'Filter Pattern', 'Vowel Filter', 'Slicearranger', 'Tonalizer', 'Spectralizer']);
    expect(Number(e.params['0'])).toBeCloseTo(101 / 127, 2);
  });
  it('J6 presets and bank', () => {
    const j6 = m.instruments.filter((i) => i.module === "J6 Synth One");
    expect(j6.map((i) => i.state.preset)).toEqual(
      ['2025: Space Trip II', 'BellTine-y Piano', 'Desert Hypnotic: NightDrive', 'Mystic Lo-Fi: NightDrive']);
    expect(new Set(j6.map((i) => i.state.bank))).toEqual(new Set(['Red Sky Lullaby']));
  });
  it('DigiStix kit and Numa sound', () => {
    const ds = m.instruments.filter((i) => i.module === 'DigiStix');
    expect(ds.map((i) => i.state.preset)).toEqual(Array(3).fill('Acoustic Close Kit'));
    expect(m.instruments.find((i) => i.module === 'Numa Player').state.preset).toBe('4 – CP E-Grand');
  });
});
