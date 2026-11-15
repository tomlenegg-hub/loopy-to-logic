// MIDI file exports: one file per instrument, and one automation file (one track per lane).
import { midiChannels } from './arrangement.js';
import { findLanes } from './automation.js';
import { buildSmf, eventsToTrackEvents, beatsToTicks } from './smf.js';

export const CC_BASE = 20; // lane n -> CC20+n on channel n+1 (never CC0: hosts treat it as bank select)

export const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();

/** @returns [{ name, filename, bytes, noteCount }] */
export function exportInstrumentMidi(project, mixer, readResource, { offsetSign = -1 } = {}) {
  const channels = midiChannels(project, readResource, { offsetSign });
  const out = [];
  for (const ch of channels) {
    const info = mixer.instruments.find((i) => i.id === ch.instrument.id);
    const name = info?.name ?? ch.instrument.data.moduleName;
    if (!ch.events.length) continue;
    const bytes = buildSmf({
      tempo: mixer.tempo, beatsPerBar: mixer.beatsPerBar, title: name,
      tracks: [{ name, events: eventsToTrackEvents(ch.events, { channel: 0 }) }],
    });
    out.push({ name, filename: `${safeName(name)}.mid`, bytes, noteCount: ch.events.filter((e) => e.kind === 'note').length });
  }
  return out;
}

/** One SMF: a track per lane, each on its own CC and channel. Also returns the mapping for the manifest. */
export function exportAutomationMidi(project, mixer, readResource, targets = []) {
  const lanes = findLanes(project, readResource);
  const mapping = [];
  const tracks = lanes.map((lane, n) => {
    const cc = CC_BASE + n;
    const channel = n % 16;
    const t = targets.find((x) => x.lane.id === lane.id);
    const target = t?.target ? `${t.target.source} → Bus ${t.target.bus}` : null;
    mapping.push({ lane: lane.title, cc, channel: channel + 1, target, status: t?.status ?? 'to confirm' });
    return {
      name: `${lane.title} (CC${cc}, ch ${channel + 1})`,
      events: lane.events.map((e) => ({ tick: beatsToTicks(e.time), order: 1, bytes: [0xb0 | channel, cc, e.value] })),
    };
  });
  const bytes = buildSmf({ tempo: mixer.tempo, beatsPerBar: mixer.beatsPerBar, title: 'Automation lanes', tracks });
  return { filename: 'Automation lanes.mid', bytes, mapping };
}
