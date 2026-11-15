// Automation lanes: long MIDI loops (CC0) that drive Loopy slider widgets.
import { trackMidi, trackPlacements } from './arrangement.js';
import { expandEvents } from './midi.js';
import { tidyName } from './effects.js';
import { ccToGain } from './levels.js';

export const LANE_MIN_BEATS = 100;

/** All automation-lane tracks: MIDI tracks that are long and contain only controller messages. */
export function findLanes(project, readResource) {
  const lanes = [];
  for (const t of project.all('Track')) {
    if (t.data.type !== 1 || t.data.duration < LANE_MIN_BEATS) continue;
    const m = trackMidi(project, t, readResource);
    if (!m || !m.events.length || m.events.some((e) => e.kind !== 'raw')) continue;
    const placements = trackPlacements(project, t);
    const events = expandEvents(m.events, placements, t.data.duration, m.seg.offset ?? 0)
      .filter((e) => (e.bytes[0] & 0xf0) === 0xb0)
      .map((e) => ({ time: e.time, cc: e.bytes[1], value: e.bytes[2] }));
    lanes.push({
      id: t.id, title: tidyName(t.data.title) ?? `Lane ${t.id}`,
      durationBeats: t.data.duration, events,
      finalValue: events.at(-1)?.value ?? null,
    });
  }
  return lanes;
}

/** Every saved send in the project, labelled by its owner. */
export function allSends(mixer) {
  const out = [];
  const add = (owner, sends) => sends.forEach((s) => out.push({ owner, bus: s.bus, amount: s.amount }));
  mixer.instruments.forEach((i) => add(i.name, i.sends));
  mixer.groups.forEach((g) => add(g.label ?? g.colour, g.sends));
  return out;
}

/**
 * Propose a target for each lane.
 *  1. A user-confirmed entry in `known` (keyed by lane title) wins.
 *  2. Otherwise a lane whose final value / 127 equals exactly one non-zero saved send is proposed.
 *  3. Otherwise candidates are listed as "to confirm".
 */
export function proposeTargets(lanes, mixer, known = {}) {
  const sends = allSends(mixer);
  return lanes.map((lane) => {
    const k = known[lane.title];
    if (k) return { lane, status: 'confirmed', target: k };
    const v = lane.finalValue == null ? null : ccToGain(lane.finalValue);
    const matches = v == null ? [] : sends.filter((s) => Math.abs(s.amount - v) < 0.5 / 128);
    const nonZero = matches.filter((s) => s.amount > 0);
    if (nonZero.length === 1) return { lane, status: 'proposed', target: { source: nonZero[0].owner, bus: nonZero[0].bus }, reason: `final value ${lane.finalValue} (gain ${v.toFixed(4)}) matches saved send` };
    return { lane, status: 'to confirm', candidates: matches.map((s) => ({ source: s.owner, bus: s.bus })) };
  });
}
