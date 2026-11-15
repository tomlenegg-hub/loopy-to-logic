// Build the mixer model: instruments, colour groups, buses, master, sends and routing.
import { decodeEffect, tidyName } from './effects.js';
import { decodeInstrument } from './instruments.js';
import { colourName } from './project.js';
import { trackPlacements } from './arrangement.js';

const letter = (i) => String.fromCharCode(65 + i);
const clean = (s) => tidyName(s ?? '');
const pretty = (m) => (m && m === m.toUpperCase() ? m.split(' ').map((w) => (/\d/.test(w) ? w : w[0] + w.slice(1).toLowerCase())).join(' ') : m);
const dB = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

function chain(project, owner) {
  const mk = (list, position) => project.refs(list).map((e) => ({ ...decodeEffect(e), position }));
  return [...mk(owner.preFaderEffects, 'Pre'), ...mk(owner.postFaderEffects, 'Post')];
}

export function buildMixer(project, readResource, lookups = {}) {
  const pd = project.all('Project')[0].data;

  // Buses A, B, C... in audioBuses order
  const busList = project.refs(pd.audioBuses);
  const busLetter = new Map(busList.map((b, i) => [b.id, letter(i)]));
  const sendsOf = (owner) => project.refs(owner.sends).map((s) => ({
    bus: busLetter.get(s.data.bus._value) ?? '?', amount: s.data.amount, position: s.data.position,
  }));

  // Instrument names: letters appended when several share a module name, in mixer order
  const order = (pd.mixerChannelsOrder ?? []).map((r) => r._value);
  const insts = project.refs(pd.audioSources).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const byModule = new Map();
  for (const i of insts) byModule.set(pretty(i.data.moduleName), (byModule.get(pretty(i.data.moduleName)) ?? 0) + 1);
  const seen = new Map();

  // MIDI routing: instrument uid -> source group(s)
  const routes = new Map();
  for (const src of project.all('GroupMIDISource')) {
    const g = project.get(src.data.group);
    for (const dest of project.refs(src.data.destinations)) {
      const list = routes.get(dest.data.targetIdentifier) ?? [];
      list.push(g);
      routes.set(dest.data.targetIdentifier, list);
    }
  }
  const titleOf = (t) => clean(t.data.title) || null;

  const instruments = insts.map((inst) => {
    const mod = pretty(inst.data.moduleName);
    const n = seen.get(mod) ?? 0;
    seen.set(mod, n + 1);
    const label = byModule.get(mod) > 1 ? `${mod} ${letter(n)}` : mod;
    const groups = routes.get(inst.data.audioUnitIdentifier) ?? [];
    const midiTracks = groups.flatMap((g) => project.refs(g.data.tracks).filter((t) => t.data.type === 1).map((t) => ({
      id: t.id, title: titleOf(t), pitch: t.data.pitch ?? 0, rate: t.data.rate ?? 1, intervals: mergeIntervals(trackPlacements(project, t)),
    })));
    const loops = midiTracks.map((t) => t.title);
    return {
      id: inst.id, name: label, module: mod, moduleRaw: inst.data.moduleName,
      gain: inst.data.gain, gainDb: dB(inst.data.gain),
      effects: chain(project, inst.data),
      sends: sendsOf(inst.data),
      sourceGroups: groups.map((g) => g.id),
      midiLoops: loops,
      midiTracks,
      state: decodeInstrument(inst, readResource, lookups),
    };
  });

  // Colour groups that hold tracks (audio loops and MIDI loops)
  const colourGroups = [];
  for (const ref of pd.mixerChannelsOrder ?? []) {
    if (ref._type !== 'Group') continue;
    const g = project.get(ref);
    colourGroups.push(describeGroup(project, g, sendsOf, titleOf));
  }

  const buses = busList.map((b, i) => ({
    id: b.id, letter: letter(i), gain: b.data.gain, gainDb: dB(b.data.gain), effects: chain(project, b.data),
  }));

  const mo = project.get(pd.masterOutputChannel);
  const master = {
    id: mo.id, gain: mo.data.gain, gainDb: dB(mo.data.gain), effects: chain(project, mo.data),
  };

  const tempo = project.all('Clock')[0]?.data;
  return {
    tempo: tempo?.tempo, beatsPerBar: tempo?.beatsPerBar ?? 4,
    instruments, groups: colourGroups, buses, master,
    unusedTracks: colourGroups.flatMap((g) => g.tracks.filter((t) => !t.used && t.type === 'audio').map((t) => ({ ...t, colour: g.colour }))),
    superseded: findSuperseded(colourGroups, instruments),
  };
}

export function mergeIntervals(pls) {
  const iv = pls.map((p) => [p.start, p.start + p.duration]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of iv) {
    if (out.length && a <= out.at(-1)[1] + 1e-6) out.at(-1)[1] = Math.max(out.at(-1)[1], b);
    else out.push([a, b]);
  }
  return out;
}
const sameIntervals = (x, y) => x.length === y.length && x.every((v, i) => Math.abs(v[0] - y[i][0]) < 1e-3 && Math.abs(v[1] - y[i][1]) < 1e-3);

function describeGroup(project, g, sendsOf, titleOf) {
  const tracks = project.refs(g.data.tracks).map((t) => {
    const placements = trackPlacements(project, t);
    return {
      id: t.id, title: titleOf(t), type: t.data.type === 1 ? 'midi' : 'audio', duration: t.data.duration,
      pitch: t.data.pitch, volume: t.data.volume, placements: placements.length, intervals: mergeIntervals(placements),
      used: placements.length > 0,
    };
  });
  const colour = colourName(g.data.color._value);
  const audio = tracks.filter((t) => t.type === 'audio' && t.title);
  return {
    id: g.id, colour, label: audio[0]?.title ?? tracks.find((t) => t.title)?.title ?? colour,
    volume: g.data.volume, volumeDb: dB(g.data.volume),
    tracks, effects: chain(project, g.data), sends: sendsOf(g.data),
  };
}

/** Audio loops whose arrangement matches a MIDI loop that drives an instrument (the audio was replaced by MIDI). */
function findSuperseded(groups, instruments) {
  const midi = instruments.flatMap((inst) => inst.midiTracks.filter((t) => t.intervals.length).map((t) => ({ inst: inst.name, track: t })));
  const out = [];
  for (const g of groups) {
    for (const t of g.tracks) {
      if (t.type !== 'audio' || !t.used) continue;
      const m = midi.find((x) => sameIntervals(t.intervals, x.track.intervals));
      if (m) out.push({ track: t.title, colour: g.colour, replacedBy: m.inst, midiLoop: m.track.title });
    }
  }
  return out;
}
