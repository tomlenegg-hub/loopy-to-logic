// AIFF/AIFC reader (PCM 8–32 bit, big-endian or 'sowt' little-endian), 24-bit WAV writer pieces,
// and loop pitch shifting (SoundTouch, LGPL-2.1, used as a separate library).
import { SoundTouch, SimpleFilter } from 'soundtouchjs';

/** 80-bit IEEE extended -> number */
function readExtended(dv, p) {
  const exp = dv.getUint16(p) & 0x7fff;
  const sign = dv.getUint16(p) & 0x8000 ? -1 : 1;
  const hi = dv.getUint32(p + 2);
  const lo = dv.getUint32(p + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  return sign * (hi * 2 ** (exp - 16383 - 31) + lo * 2 ** (exp - 16383 - 63));
}

/** Parse the header only; returns where the sample data lives. Does not copy audio. */
export function parseAiffHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
  if (tag(0) !== 'FORM') throw new Error('Not an AIFF file');
  const form = tag(8);
  if (form !== 'AIFF' && form !== 'AIFC') throw new Error('Not an AIFF file');
  let comm = null;
  let ssnd = null;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = tag(p);
    const size = dv.getUint32(p + 4);
    if (id === 'COMM') {
      comm = {
        channels: dv.getInt16(p + 8),
        frames: dv.getUint32(p + 10),
        bits: dv.getInt16(p + 14),
        sampleRate: readExtended(dv, p + 16),
        compression: form === 'AIFC' ? tag(p + 26) : 'NONE',
      };
    } else if (id === 'SSND') {
      ssnd = { dataStart: p + 16 + dv.getUint32(p + 8), size };
    }
    p += 8 + size + (size & 1);
  }
  if (!comm || !ssnd) throw new Error('AIFF missing COMM or SSND');
  if (!['NONE', 'sowt', 'twos'].includes(comm.compression)) throw new Error(`Unsupported AIFF compression ${comm.compression}`);
  return { ...comm, ...ssnd, littleEndian: comm.compression === 'sowt' };
}

/** Decode a range of frames to planar Float32 [L, R] (mono is duplicated). */
export function decodeAiff(bytes, header, startFrame = 0, numFrames = header.frames - startFrame) {
  const h = header;
  const bps = h.bits / 8;
  const frameBytes = bps * h.channels;
  const n = Math.max(0, Math.min(numFrames, h.frames - startFrame));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const scale = 1 / 2 ** (h.bits - 1);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = h.littleEndian;
  const sample = (p) => {
    switch (bps) {
      case 1: return (bytes[p] << 24 >> 24) * scale;
      case 2: return dv.getInt16(p, le) * scale;
      case 3: {
        const b0 = bytes[p], b1 = bytes[p + 1], b2 = bytes[p + 2];
        const v = le ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
        return (v << 8 >> 8) * scale;
      }
      default: return dv.getInt32(p, le) * scale;
    }
  };
  for (let i = 0; i < n; i++) {
    const p = h.dataStart + (startFrame + i) * frameBytes;
    left[i] = sample(p);
    right[i] = h.channels > 1 ? sample(p + bps) : left[i];
  }
  return { left, right, sampleRate: h.sampleRate };
}

// ---------- WAV (24-bit PCM) ----------
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u16le = (n) => [n & 255, (n >> 8) & 255];
const asc = (s) => Array.from(s, (c) => c.charCodeAt(0));

/** RIFF header for 24-bit stereo PCM with `frames` frames. Data follows as `frames * 6` bytes. */
export function wavHeader24(frames, sampleRate, channels = 2) {
  const dataBytes = frames * channels * 3;
  return new Uint8Array([
    ...asc('RIFF'), ...u32le(36 + dataBytes), ...asc('WAVE'),
    ...asc('fmt '), ...u32le(16), ...u16le(1), ...u16le(channels), ...u32le(sampleRate),
    ...u32le(sampleRate * channels * 3), ...u16le(channels * 3), ...u16le(24),
    ...asc('data'), ...u32le(dataBytes),
  ]);
}

/** Planar float -> interleaved 24-bit little-endian PCM, hard-clipped. Returns bytes and clipped sample count. */
export function floatTo24(left, right, start = 0, count = left.length - start) {
  const out = new Uint8Array(count * 6);
  let clipped = 0;
  const conv = (v) => {
    if (v > 1 || v < -1) clipped++;
    return Math.max(-8388608, Math.min(8388607, Math.round(v * 8388608)));
  };
  for (let i = 0; i < count; i++) {
    const l = conv(left[start + i]);
    const r = conv(right[start + i]);
    const o = i * 6;
    out[o] = l & 255; out[o + 1] = (l >> 8) & 255; out[o + 2] = (l >> 16) & 255;
    out[o + 3] = r & 255; out[o + 4] = (r >> 8) & 255; out[o + 5] = (r >> 16) & 255;
  }
  return { bytes: out, clipped };
}

// ---------- Pitch shifting ----------
function runSoundTouch(left, right, semitones, sampleRate) {
  const n = left.length;
  const inter = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { inter[2 * i] = left[i]; inter[2 * i + 1] = right[i]; }
  const source = {
    extract(target, numFrames, position) {
      const avail = Math.max(0, Math.min(numFrames, n - position));
      target.set(inter.subarray(position * 2, (position + avail) * 2));
      return avail;
    },
  };
  const st = new SoundTouch();
  st.pitchSemitones = semitones;
  const filter = new SimpleFilter(source, st);
  const outL = new Float32Array(n + 8192);
  const outR = new Float32Array(n + 8192);
  const buf = new Float32Array(4096 * 2);
  let w = 0;
  for (;;) {
    const got = filter.extract(buf, 4096);
    if (!got) break;
    for (let i = 0; i < got && w < outL.length; i++, w++) { outL[w] = buf[2 * i]; outR[w] = buf[2 * i + 1]; }
  }
  return { left: outL.subarray(0, w), right: outR.subarray(0, w) };
}

/** Amplitude envelope at ~1 ms resolution. */
function envelope(ch, w) {
  const out = new Float32Array(Math.floor(ch.length / w));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < w; j++) { const v = ch[i * w + j]; sum += v * v; }
    out[i] = Math.sqrt(sum / w);
  }
  return out;
}

/** Circular lag (frames) at which `shifted` best matches `orig`, searched within +/- maxMs. */
function bestLag(orig, shifted, sampleRate, maxMs = 150) {
  const w = Math.max(1, Math.round(sampleRate / 1000));
  const a = envelope(orig, w);
  const b = envelope(shifted, w);
  const n = a.length;
  let best = { lag: 0, score: -Infinity };
  for (let lag = -maxMs; lag <= maxMs; lag++) {
    let c = 0;
    for (let i = 0; i < n; i++) c += a[i] * b[(i + lag + n) % n];
    if (c > best.score) best = { lag, score: c };
  }
  return best.lag * w;
}

/**
 * Pitch-shift a seamless loop at constant length. The loop is tiled three times and shifted so the middle
 * copy has no edge artefacts. SoundTouch adds an unpredictable delay, so the middle copy is rotated until its
 * amplitude envelope lines up with the source loop (timing is preserved by a constant-tempo pitch shift).
 */
export function shiftLoop(loop, semitones) {
  if (!semitones) return loop;
  const n = loop.left.length;
  const tile = (ch) => { const t = new Float32Array(n * 3); t.set(ch, 0); t.set(ch, n); t.set(ch, 2 * n); return t; };
  const out = runSoundTouch(tile(loop.left), tile(loop.right), semitones, loop.sampleRate);
  const mid = (ch) => { const r = new Float32Array(n); r.set(ch.subarray(n, n + n)); return r; };
  const mL = mid(out.left);
  const mR = mid(out.right);
  const lag = bestLag(loop.left, mL, loop.sampleRate);
  const rot = (ch) => {
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) r[i] = ch[(i + lag + n) % n];
    return r;
  };
  return { left: rot(mL), right: rot(mR), sampleRate: loop.sampleRate, alignedBy: lag };
}
