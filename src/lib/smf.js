// Standard MIDI File (format 1) writer, plus a small reader used by the tests.
export const PPQ = 480;

const vlq = (n) => {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
};
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >> 8) & 255, n & 255];
const ascii = (s) => Array.from(s, (c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63));
const utf8 = (s) => Array.from(new TextEncoder().encode(s));

export const beatsToTicks = (b) => Math.round(b * PPQ);

/** Build one track chunk from absolute-tick events [{tick, order, bytes}] plus a name. */
function trackChunk(name, events, endTick = 0) {
  const body = [];
  const nm = utf8(name);
  body.push(0, 0xff, 0x03, ...vlq(nm.length), ...nm);
  const sorted = [...events].sort((a, b) => a.tick - b.tick || (a.order ?? 1) - (b.order ?? 1));
  let last = 0;
  for (const e of sorted) {
    body.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(...vlq(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...u32(body.length), ...body];
}

const tempoTrack = (tempo, beatsPerBar, name) => {
  const mpqn = Math.round(60000000 / tempo);
  return trackChunk(name, [
    { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (mpqn >> 16) & 255, (mpqn >> 8) & 255, mpqn & 255] },
    { tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, beatsPerBar, 2, 24, 8] },
  ]);
};

/**
 * Notes + raw messages -> track events. Note-offs sort before note-ons at the same tick (order 0 vs 1).
 * Raw messages keep their own status byte; if `channel` is given it overrides the channel nibble.
 */
export function eventsToTrackEvents(events, { channel = 0, transpose = 0 } = {}) {
  const out = [];
  for (const e of events) {
    const tick = beatsToTicks(e.time);
    if (e.kind === 'note') {
      const note = Math.max(0, Math.min(127, e.note + transpose));
      const dur = Math.max(1, beatsToTicks(e.duration || 0.01));
      out.push({ tick, order: 1, bytes: [0x90 | channel, note, e.velocity || 64] });
      out.push({ tick: tick + dur, order: 0, bytes: [0x80 | channel, note, 0] });
    } else if (e.bytes?.length) {
      const b = [...e.bytes];
      if (channel !== null && b[0] >= 0x80 && b[0] < 0xf0) b[0] = (b[0] & 0xf0) | channel;
      out.push({ tick, order: 1, bytes: b });
    }
  }
  return out;
}

/** tracks: [{name, events: [{tick, order, bytes}]}] */
export function buildSmf({ tempo, beatsPerBar = 4, title = 'Loopy export', tracks }) {
  const chunks = [tempoTrack(tempo, beatsPerBar, title), ...tracks.map((t) => trackChunk(t.name, t.events))];
  const header = [...ascii('MThd'), ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(PPQ)];
  return new Uint8Array([...header, ...chunks.flat()]);
}

/** Minimal SMF reader (format 0/1): returns { ppq, tracks: [{name, events:[{tick, bytes}]}] } */
export function readSmf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ppq = dv.getUint16(12);
  const n = dv.getUint16(10);
  let p = 14;
  const tracks = [];
  for (let t = 0; t < n; t++) {
    const len = dv.getUint32(p + 4);
    let q = p + 8;
    const end = q + len;
    let tick = 0;
    let running = 0;
    const events = [];
    let name = '';
    const readVlq = () => {
      let v = 0, b;
      do { b = bytes[q++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
      return v;
    };
    while (q < end) {
      tick += readVlq();
      let s = bytes[q];
      if (s === 0xff) {
        const type = bytes[q + 1];
        q += 2;
        const l = readVlq();
        if (type === 0x03) name = new TextDecoder().decode(bytes.subarray(q, q + l));
        events.push({ tick, meta: type, bytes: Array.from(bytes.subarray(q, q + l)) });
        q += l;
        continue;
      }
      if (s & 0x80) { running = s; q++; } else s = running;
      const dataLen = (s & 0xf0) === 0xc0 || (s & 0xf0) === 0xd0 ? 1 : 2;
      events.push({ tick, bytes: [s, ...bytes.subarray(q, q + dataLen)] });
      q += dataLen;
    }
    tracks.push({ name, events });
    p = end;
  }
  return { ppq, tracks };
}
