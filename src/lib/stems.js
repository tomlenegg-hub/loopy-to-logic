// Dry audio stems: one 24-bit WAV per colour group that holds audio loops, arranged as the sequencer plays them
// (from bar 1). Rendered in ~1 s windows so memory stays small; only the decoded loops are held.
import { trackPlacements } from './arrangement.js';
import { parseAiffHeader, decodeAiff, shiftLoop, wavHeader24, floatTo24 } from './audio.js';
import { safeName } from './export-midi.js';

/** Which colour groups become stems. Superseded and unused loops are skipped unless asked for. */
export function planStems(project, mixer, { includeSuperseded = false, includeUnused = false } = {}) {
  const spb = 60 / mixer.tempo;
  const stems = [];
  for (const g of mixer.groups) {
    const tracks = [];
    for (const mt of g.tracks) {
      if (mt.type !== 'audio') continue;
      const superseded = mixer.superseded.some((s) => s.colour === g.colour && s.track === mt.title);
      if (!mt.used && !includeUnused) continue;
      if (superseded && !includeSuperseded) continue;
      const t = project.get(mt.id);
      const layer = project.refs(t.data.layers)[0];
      const seg = project.refs(layer?.data.segments)[0]?.data;
      if (!seg?.resourceId) continue;
      const pitch = t.data.pitch || seg.scaledPitch || 0;
      tracks.push({
        id: t.id, title: mt.title, resource: `${seg.resourceId}.aiff`, resourceId: seg.resourceId,
        pitch, gain: (t.data.volume ?? 1) * (layer.data.volume ?? 1) * (seg.volume ?? 1),
        loopBeats: t.data.duration, offsetBeats: seg.offset ?? 0,
        regionOffsetBeats: seg.resourceSubregion?._value?.offset ?? 0,
        // An unused loop that was explicitly included is rendered as one pass from bar 1
        placements: mt.used ? trackPlacements(project, t) : [{ start: 0, duration: t.data.duration }],
        warnings: [t.data.speed !== undefined && t.data.speed !== 1 ? `speed ${t.data.speed} not applied` : null].filter(Boolean),
      });
    }
    if (!tracks.length) continue;
    const endBeat = Math.max(...tracks.flatMap((t) => t.placements.map((p) => p.start + p.duration)));
    stems.push({
      id: g.id, colour: g.colour, label: g.label, filename: `${safeName(`${g.colour} – ${g.label}`)}.wav`,
      tracks, endBeat, spb, tempo: mixer.tempo,
    });
  }
  return stems;
}

/**
 * Stream a stem as WAV chunks. First chunk is the header, the rest are PCM windows.
 * opts: { offsetSign (default -1, see MIDI), range: {startBeat, endBeat} to render a slice (header covers the slice),
 *         stats: object filled with {clipped, peak, shifted}, onProgress(fraction), windowFrames }
 */
export async function* renderStem(stem, readResource, opts = {}) {
  const { offsetSign = -1, stats = {}, onProgress, windowFrames } = opts;
  stats.clipped = 0; stats.peak = 0; stats.shifted = [];
  const first = parseAiffHeader(readResource(stem.tracks[0].resource));
  const sr = first.sampleRate;
  const spf = stem.spb * sr; // frames per beat
  const range = opts.range ?? { startBeat: 0, endBeat: stem.endBeat };
  const startFrame = Math.round(range.startBeat * spf);
  const endFrame = Math.round(range.endBeat * spf);
  const total = endFrame - startFrame;
  const win = windowFrames ?? sr;

  // Decode (and pitch shift) each distinct loop once
  const loops = new Map();
  const loopFor = (t) => {
    const key = `${t.resource}|${t.regionOffsetBeats}|${t.loopBeats}|${t.pitch}`;
    if (loops.has(key)) return loops.get(key);
    const bytes = readResource(t.resource);
    if (!bytes) throw new Error(`Missing audio resource ${t.resource}`);
    const h = parseAiffHeader(bytes);
    const L = Math.round(t.loopBeats * spf);
    const dec = decodeAiff(bytes, h, Math.round(t.regionOffsetBeats * spf), L);
    // pad if the file is a few frames shorter than the loop
    const loop = dec.left.length === L ? dec : (() => {
      const l = new Float32Array(L), r = new Float32Array(L);
      l.set(dec.left); r.set(dec.right);
      return { left: l, right: r, sampleRate: sr };
    })();
    const shifted = t.pitch ? shiftLoop(loop, t.pitch) : loop;
    if (t.pitch) stats.shifted.push(`${t.title} ${t.pitch > 0 ? '+' : ''}${t.pitch}`);
    const out = { ...shifted, L };
    loops.set(key, out);
    return out;
  };
  const prepared = stem.tracks.map((t) => ({
    t, loop: loopFor(t), offFrames: Math.round(t.offsetBeats * spf),
    places: t.placements.map((p) => {
      const s = Math.round(p.start * spf), e = Math.round((p.start + p.duration) * spf);
      return { s, e, cut: Math.abs(p.duration / t.loopBeats - Math.round(p.duration / t.loopBeats)) > 1e-6 };
    }),
  }));

  yield wavHeader24(total, sr);

  const fade = Math.round(sr * 0.003);
  for (let w0 = startFrame; w0 < endFrame; w0 += win) {
    const n = Math.min(win, endFrame - w0);
    const accL = new Float32Array(n);
    const accR = new Float32Array(n);
    for (const { t, loop, offFrames, places } of prepared) {
      const { L } = loop;
      for (const p of places) {
        const a = Math.max(p.s, w0), b = Math.min(p.e, w0 + n);
        if (a >= b) continue;
        for (let f = a; f < b; f++) {
          // output position p holds content (p - offset) for offsetSign -1, i.e. source = (p + offset) mod L
          let src = (f - p.s - offsetSign * offFrames) % L;
          if (src < 0) src += L;
          let g = t.gain;
          if (p.cut && p.e - f < fade) g *= (p.e - f) / fade;
          accL[f - w0] += loop.left[src] * g;
          accR[f - w0] += loop.right[src] * g;
        }
      }
    }
    for (let i = 0; i < n; i++) stats.peak = Math.max(stats.peak, Math.abs(accL[i]), Math.abs(accR[i]));
    const { bytes, clipped } = floatTo24(accL, accR, 0, n);
    stats.clipped += clipped;
    onProgress?.((w0 - startFrame + n) / total);
    yield bytes;
    await Promise.resolve(); // let the UI breathe between windows
  }
}

export async function renderStemToBytes(stem, readResource, opts) {
  const parts = [];
  for await (const c of renderStem(stem, readResource, opts)) parts.push(c);
  const len = parts.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of parts) { out.set(c, p); p += c.length; }
  return out;
}
