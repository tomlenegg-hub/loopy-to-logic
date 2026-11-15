// Loopy MIDI record parsing and arrangement expansion.
// Record: u8 0x0C | u64 LE time (beats*1e9) | u8 type | u16 LE length | payload
//   type 0: raw MIDI bytes; type 1: u8 note, u8 ?, u8 velocity, u64 LE duration (beats*1e9), u8 pad
const NS = 1e9;

/** Parse a Loopy MIDI blob into events sorted by time. Times are in beats relative to loop start. */
export function parseLoopyMidi(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const events = [];
  let p = 0;
  while (p + 12 <= bytes.length) {
    if (bytes[p] !== 0x0c) throw new Error(`Bad MIDI record marker 0x${bytes[p].toString(16)} at ${p}`);
    const time = Number(dv.getBigUint64(p + 1, true)) / NS;
    const type = bytes[p + 9];
    const len = dv.getUint16(p + 10, true);
    const s = p + 12;
    if (s + len > bytes.length) throw new Error(`Truncated MIDI record at ${p}`);
    if (type === 1) {
      events.push({
        kind: 'note', time,
        note: bytes[s], velocity: bytes[s + 2],
        duration: len >= 12 ? Number(dv.getBigUint64(s + 3, true)) / NS : 0,
      });
    } else {
      events.push({ kind: 'raw', time, bytes: Array.from(bytes.subarray(s, s + len)) });
    }
    p = s + len;
  }
  events.sort((a, b) => a.time - b.time);
  return events;
}

/**
 * Expand a looped event list across arrangement placements.
 * placements: [{start, duration}] in beats. loopLength: loop length in beats.
 * offset: segment offset in beats (content placed at (t + shift) mod loop; sign configurable).
 * Events starting at or after a placement's end are dropped; notes are clipped to the end.
 */
export function expandEvents(events, placements, loopLength, offset = 0, offsetSign = -1) {
  const out = [];
  const L = loopLength;
  const mod = (x) => ((x % L) + L) % L;
  for (const pl of placements) {
    const end = pl.start + pl.duration;
    const loops = Math.ceil(pl.duration / L);
    for (let k = 0; k < loops; k++) {
      for (const ev of events) {
        const t = pl.start + k * L + mod(ev.time + offsetSign * offset);
        if (t >= end - 1e-9 || t < pl.start + k * L - 1e-9) continue;
        if (ev.kind === 'note') out.push({ ...ev, time: t, duration: Math.min(ev.duration, end - t) });
        else out.push({ ...ev, time: t });
      }
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
