import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DUB, BASELINE, folderReader, loadFixture } from './helpers.js';
import { buildMixer } from '../src/lib/mixer.js';
import { findLanes, proposeTargets } from '../src/lib/automation.js';
import { collectBaseline } from '../src/lib/baseline.js';
import { generateManifest } from '../src/lib/manifest.js';

const j = (f) => JSON.parse(fs.readFileSync(`data/${f}`, 'utf8'));
let md, mixer, lanes, targets;

beforeAll(async () => {
  const lookups = { numaSounds: j('numa-sounds.json'), turnado: j('turnado-subpresets.json') };
  const project = await loadFixture(DUB);
  const rd = folderReader(DUB);
  mixer = buildMixer(project, rd, lookups);
  lanes = findLanes(project, rd);
  targets = proposeTargets(lanes, mixer, j('automation-targets.json'));
  const baseline = collectBaseline(await loadFixture(BASELINE), folderReader(BASELINE), lookups);
  md = generateManifest({ mixer, lanes, targets, baseline, lookups, odc: j('odc-params.json'), projectName: 'Adabadaba Dub', baselineName: 'Logic Migration Project.lpproj' });
});

describe('automation (acceptance)', () => {
  const lane = (t) => lanes.find((l) => l.title.startsWith(t));
  it('finds five lanes', () => expect(lanes).toHaveLength(5));
  it('Bass Distortion ends on 38; Bass Turnado ends on 0', () => {
    expect(lane('Bass Distortion').finalValue).toBe(38);
    expect(lane('Bass Turnado').finalValue).toBe(0);
  });
  it('lanes span 480 beats = bars 1–121', () => {
    for (const l of lanes) expect(l.durationBeats / 4 + 1).toBeGreaterThanOrEqual(120);
    expect(lane('Bass Distortion').durationBeats / 4 + 1).toBe(121);
  });
  it('Bass Distortion target is proposed from data alone (value match)', () => {
    const t = proposeTargets(lanes, mixer, {}).find((x) => x.lane.title.startsWith('Bass Distortion'));
    expect(t.status).toBe('proposed');
    expect(t.target).toEqual({ source: 'Bass nofx', bus: 'D' });
  });
});

describe('arrangement', () => {
  it('Bass main is unused', () => expect(mixer.unusedTracks.map((t) => t.title)).toEqual(['Bass main']));
  it('Blue "Stabs" audio is superseded by the keys MIDI on Numa Player', () => {
    expect(mixer.superseded).toEqual([
      { track: 'Stabs', colour: 'Blue', replacedBy: 'Numa Player', midiLoop: 'Adabadaba_keys_midi_no_pc' }]);
  });
  it('tempo 75, 4/4', () => {
    expect(mixer.tempo).toBe(75);
    expect(mixer.beatsPerBar).toBe(4);
  });
});

describe('manifest text (acceptance)', () => {
  const has = (s) => expect(md).toContain(s);
  it('counts 23 effect instances', () => has('23 effect instances in total.'));
  it('uses en dashes and never em dashes', () => expect(md).not.toContain('—'));
  it('Bus G is +4 dB, others 0 dB', () => has("Bus G's output level is +4 dB; all other buses are at 0 dB."));
  it('master chain and gain note', () => {
    has('| 2 | RoughRider3 | 03 – Just A Bit Off The Top | Post |');
    has('−9.5 dB');
  });
  it('Bus A ODC tweaks', () => {
    has('Mix: 50% → 89%');
    has('Algo04: # Taps 1: 15 → 12');
    has('Algo04: # Taps 2: 15 → 9');
  });
  it('Turnado slot table and knob 1', () => {
    has('| 1 | Ventilator | Pitch Looper | 101 of 127 |');
    has('Knob 1 set to 101 (of 127)');
  });
  it('Bass nofx sends 30% to D, 0% to E', () => has('Sends 30% to **Bus D**, and **Bus E** at 0%.'));
  it('flags tweaks to an unselected algorithm as no effect', () => has('no effect with the selected algorithm'));
  it('lists Bass main as unused', () => has('this loop is not placed in the arrangement'));
});
