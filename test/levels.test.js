import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DUB, BASELINE, folderReader, loadFixture } from './helpers.js';
import { buildMixer } from '../src/lib/mixer.js';
import { findLanes, proposeTargets } from '../src/lib/automation.js';
import { collectBaseline } from '../src/lib/baseline.js';
import { generateManifest } from '../src/lib/manifest.js';
import { fmtDb, ccToGain } from '../src/lib/levels.js';

const j = (f) => JSON.parse(fs.readFileSync(`data/${f}`, 'utf8'));
let md, mixer;
beforeAll(async () => {
  const lookups = { numaSounds: j('numa-sounds.json'), turnado: j('turnado-subpresets.json'), internalSequencers: j('internal-sequencers.json') };
  const project = await loadFixture(DUB);
  const rd = folderReader(DUB);
  mixer = buildMixer(project, rd, lookups);
  const targets = proposeTargets(findLanes(project, rd), mixer, j('automation-targets.json'));
  const baseline = collectBaseline(await loadFixture(BASELINE), folderReader(BASELINE), lookups);
  md = generateManifest({ mixer, lanes: [], targets, baseline, lookups, odc: j('odc-params.json'), projectName: 'Adabadaba Dub', baselineName: 'Logic Migration Project.lpproj' });
});

describe('item 5: levels in dB', () => {
  it('formats linear gain as dB to 0.1 dB, with off for zero', () => {
    expect(fmtDb(0.7079458)).toBe('−3.0 dB');
    expect(fmtDb(1.584893)).toBe('+4.0 dB');
    expect(fmtDb(0.33496543765068054)).toBe('−9.5 dB');
    expect(fmtDb(1)).toBe('0.0 dB');
    expect(fmtDb(0)).toBe('off (−∞)');
    expect(fmtDb(0.296875)).toBe('−10.5 dB');
  });
  it('CC n is gain n/128: 38 -> 0.296875', () => expect(ccToGain(38)).toBe(0.296875));
  it('the Adabadaba sends come out as −3.0 dB x2, −1.9 dB, −10.5 dB and off x4', () => {
    const sends = [...mixer.instruments.flatMap((i) => i.sends), ...mixer.groups.flatMap((g) => g.sends)].map((s) => fmtDb(s.amount));
    expect(sends.sort()).toEqual(['−1.9 dB', '−10.5 dB', '−3.0 dB', '−3.0 dB', 'off (−∞)', 'off (−∞)', 'off (−∞)', 'off (−∞)'].sort());
  });
  it('the manifest shows levels in dB, not percentages', () => {
    expect(md).toContain('Sends −3.0 dB to **Bus F**.');
    expect(md).toContain('Sends −1.9 dB to **Bus C**.');
    expect(md).toContain('**Bus A**, **Bus B**, **Bus G** off.');
    expect(md).toContain('| C | Other Desert Cities | Default | Post | DigiStix C (−1.9 dB), J6 Synth One B (−3.0 dB) |');
    expect(md).toContain('Volume −2.3 dB.'); // Orange group, gain 0.764
    expect(md).not.toMatch(/Sends \d+%|Volume \d+%|\(\d+%\) \|/);
  });
  it('the automation section notes the CC conversion and shows final values in dB', () => {
    expect(md).toContain('n/128');
    expect(md).toContain('38 of 127 (−10.5 dB)');
    expect(md).toContain('0 of 127 (off)');
  });
});

describe('items 6 and 10: rate warnings and notes to confirm', () => {
  const section = (name) => md.split('### ').find((sec) => sec.startsWith(name)) ?? '';
  it('J6 C and D carry the rate warning; J6 A and B do not', () => {
    expect(section('J6 Synth One C')).toContain('**Rate**');
    expect(section('J6 Synth One D')).toContain('**Rate**');
    expect(section('J6 Synth One A')).not.toContain('**Rate**');
    expect(section('J6 Synth One B')).not.toContain('**Rate**');
    expect(md).toContain('Loopy plays this loop at 2× rate');
    expect(md).toContain('set Transpose to −12 or +12 in the Region inspector');
  });
  it('lists the two things still to confirm by ear', () => {
    expect(md).toContain('Segment offset direction');
    expect(md).toContain('MIDI loops with a rate other than 1');
  });
});

describe('item 7: internal sequencers', () => {
  it('flags J6 C and D (sequencer on) and not A or B', () => {
    expect(mixer.instruments.filter((i) => i.internal).map((i) => i.name)).toEqual(['J6 Synth One C', 'J6 Synth One D']);
    const c = mixer.instruments.find((i) => i.name === 'J6 Synth One C').internal;
    expect(c.active).toEqual(['internal step sequencer']);
    expect(c.info).toEqual([{ label: 'mono mode', on: true }, { label: 'tempo sync', on: true }]);
    expect(mixer.instruments.find((i) => i.name === 'J6 Synth One D').internal.info[1]).toEqual({ label: 'tempo sync', on: false });
  });
  it('the manifest warns, with the tempo-sync advice', () => {
    expect(md).toContain("toggle J6's tempo sync button and start playback from bar 1");
    expect(md).toContain('tempo sync off'); // J6 D is saved with tempo sync off
  });
  it('is driven by a lookup so other plug-ins can be added', async () => {
    const project = await loadFixture(DUB);
    const rule = { 'numa player': { label: 'Numa test rule', active: { INVALID: 'x' }, info: {}, advice: 'do something' } };
    const m = buildMixer(project, folderReader(DUB), { numaSounds: j('numa-sounds.json'), internalSequencers: rule });
    expect(m.instruments.some((i) => i.internal)).toBe(false); // no param matches, and J6 has no rule here
  });
});

describe('item 9: lookups', () => {
  it('Numa sound, Turnado sub-presets, J6 asterisks', () => {
    expect(j('numa-sounds.json')['cae05f60-9484-4b14-894b-5921f3403a73']).toBe('4 – CP E-Grand');
    expect(j('turnado-subpresets.json').Ventilator).toBe('Pitch Looper');
    expect(j('turnado-subpresets.json').FastStops).toBe('Vinylizer');
    expect(mixer.instruments.filter((i) => i.module === 'J6 Synth One').every((i) => !i.state.preset.includes('*'))).toBe(true);
    expect(md).not.toMatch(/Space Trip II\*|BellTine-y Piano\*/);
  });
});

describe('item 8: importing section', () => {
  it('explains the iPad import workflow', () => {
    expect(md).toContain('## 10. Importing into Logic (iPad)');
    expect(md).toContain('Windowed Apps');
    expect(md).toContain('Stage Manager');
    expect(md).toContain('Settings → Multitasking & Gestures');
  });
});
