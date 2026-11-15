// Arrangement + MIDI channel extraction. `readResource(name)` returns Uint8Array | undefined,
// so the same code runs on a Node folder or a zip held in the browser.
import { b64ToBytes } from './project.js';
import { parseLoopyMidi, expandEvents } from './midi.js';

/** Placements for a track, in beats. Missing duration = the track's loop length. */
export function trackPlacements(project, trackObj) {
  const L = trackObj.data.duration;
  for (const st of project.all('TrackPlaybackSequenceTrack')) {
    if (st.data.track?._value !== trackObj.id) continue;
    return project.refs(st.data.segments).map((s) => ({ start: s.data.start, duration: s.data.duration ?? L }));
  }
  return [];
}

export function trackMidi(project, trackObj, readResource) {
  const layer = project.refs(trackObj.data.layers)[0];
  const seg = project.refs(layer?.data.segments)[0]?.data;
  if (!seg) return null;
  let bytes;
  if (seg.midiData) bytes = b64ToBytes(seg.midiData._value);
  else bytes = readResource(`${seg.resourceId}.lpmidi`);
  if (!bytes) return null;
  return { seg, events: parseLoopyMidi(bytes) };
}

/**
 * Playback-speed factor of a loop. Loopy's `rate` ("Rate (Variable Pitch)") plays a loop faster or slower and
 * `speed` is its time-stretch control; for MIDI loops both change how fast the notes play, so the factors multiply.
 * `pitch` is NOT applied here: whether Loopy also transposes a MIDI loop when rate is not 1 is unconfirmed,
 * so it is reported as a manifest warning instead.
 */
export const loopFactor = (track) => {
  const f = (Number.isFinite(track.data.rate) && track.data.rate > 0 ? track.data.rate : 1)
    * (Number.isFinite(track.data.speed) && track.data.speed > 0 ? track.data.speed : 1);
  return f;
};

/**
 * One entry per (MIDI-fed) plug-in instrument, with its arranged events.
 * Effective loop length = duration / factor; every note time and duration is divided by the factor.
 * applyPitch (default false) transposes notes by Track.pitch semitones.
 */
export function midiChannels(project, readResource, { offsetSign = -1, applyPitch = false } = {}) {
  const instByUid = new Map(project.all('PluginAudioSource').map((o) => [o.data.audioUnitIdentifier, o]));
  const out = [];
  for (const src of project.all('GroupMIDISource')) {
    const group = project.get(src.data.group);
    if (!group) continue;
    for (const dest of project.refs(src.data.destinations)) {
      const inst = instByUid.get(dest.data.targetIdentifier);
      if (!inst) continue;
      const tracks = [];
      for (const t of project.refs(group.data.tracks)) {
        if (t.data.type !== 1) continue;
        const m = trackMidi(project, t, readResource);
        if (!m) continue;
        const factor = loopFactor(t);
        const L = t.data.duration / factor;
        const scaled = factor === 1 ? m.events : m.events.map((e) => ({ ...e, time: e.time / factor, ...(e.kind === 'note' ? { duration: e.duration / factor } : {}) }));
        const placements = trackPlacements(project, t);
        const transpose = applyPitch ? Math.round(t.data.pitch ?? 0) : 0;
        const events = expandEvents(scaled, placements, L, (m.seg.offset ?? 0) / factor, offsetSign).map((e) =>
          e.kind === 'note' && transpose ? { ...e, note: Math.max(0, Math.min(127, e.note + transpose)) } : e);
        tracks.push({ track: t, placements, events, transpose, factor });
      }
      out.push({ instrument: inst, group, tracks, events: tracks.flatMap((t) => t.events).sort((a, b) => a.time - b.time) });
    }
  }
  return out;
}

export const noteCount = (events) => events.filter((e) => e.kind === 'note').length;
