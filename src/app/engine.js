// Page-independent engine: analyse a zipped Loopy project, then export stems / MIDI / automation / manifest.
// Works in Safari and in Node (given Blob), so it is covered by the same tests as the library.
import { Zip, ZipPassThrough, ZipDeflate } from 'fflate';
import { openZip, findProjects } from './zipfile.js';
import { loadProject } from '../lib/project.js';
import { buildMixer } from '../lib/mixer.js';
import { findLanes, proposeTargets } from '../lib/automation.js';
import { collectBaseline } from '../lib/baseline.js';
import { generateManifest } from '../lib/manifest.js';
import { exportInstrumentMidi, exportAutomationMidi } from '../lib/export-midi.js';
import { planStems, renderStem } from '../lib/stems.js';
import { trackPlacements } from '../lib/arrangement.js';
import numaSounds from '../../data/numa-sounds.json';
import turnadoSub from '../../data/turnado-subpresets.json';
import automationKnown from '../../data/automation-targets.json';
import odc from '../../data/odc-params.json';
import internalSequencers from '../../data/internal-sequencers.json';

export const LOOKUPS = { numaSounds, turnado: turnadoSub, internalSequencers };

const isAudio = (n) => /\.(aiff?|wav|caf)$/i.test(n);

/** Thrown when a zip holds several projects and the caller has not said which one to use. */
export class NeedsChoiceError extends Error {
  constructor(role, candidates) {
    super(`${role}: this zip contains ${candidates.length} projects – choose one.`);
    this.name = 'NeedsChoiceError';
    this.role = role;
    this.candidates = candidates;
  }
}
export class SameFileError extends Error {
  constructor() {
    super('The baseline is the same file as the project. Choose a different baseline, or leave it empty – an identical baseline would show no tweaks.');
    this.name = 'SameFileError';
  }
}

export const ROLE = { project: 'Project', baseline: 'Baseline project' };
export const fileSig = (f) => `${f.name}|${f.size}|${f.lastModified ?? 0}`;

const describeError = (e) => {
  const msg = e?.message || String(e);
  if (e instanceof RangeError || /memory|allocation|too large/i.test(msg)) return `out of memory while reading (${msg}). Try closing other apps, or export the baseline separately.`;
  return msg;
};

/**
 * Open a zipped Loopy project: read the central directory, then only what is needed – Project.sqlite and the
 * small resources (.moduleState, .lpmidi, plists). Audio is never read here.
 */
export async function openProjectZip(file, { sqlOptions, root: chosenRoot, role = 'project' } = {}) {
  const label = ROLE[role] ?? role;
  try {
    const zip = await openZip(file);
    const fallback = (file.name ?? '').replace(/\.zip$/i, '') || 'Loopy project';
    const found = findProjects(zip.names, fallback);
    if (!found.length) {
      const shown = zip.names.slice(0, 20).join('\n  ');
      throw new Error(`No Loopy project found (no Project.sqlite anywhere in the zip). First ${Math.min(20, zip.names.length)} of ${zip.names.length} entries:\n  ${shown}`);
    }
    let root = found[0];
    if (found.length > 1) {
      root = found.find((f) => f.prefix === chosenRoot);
      if (!root) throw new NeedsChoiceError(label, found);
    }
    const sqlite = await zip.read(`${root.prefix}Project.sqlite`);
    const project = await loadProject(sqlite, sqlOptions);
    const cache = new Map();
    const resPrefix = `${root.prefix}Resources/`;
    for (const n of zip.names) {
      if (!n.startsWith(resPrefix) || n.endsWith('/') || isAudio(n)) continue;
      if (n.split('/').at(-1).startsWith('.')) continue;
      cache.set(n.slice(resPrefix.length), await zip.read(n));
    }
    return {
      zip, root, project, cache, candidates: found,
      audioNames: zip.names.filter((n) => n.startsWith(resPrefix) && isAudio(n)).map((n) => n.slice(resPrefix.length)),
      readResource: (name) => cache.get(name),
      /** Fetch audio files into the cache (call before rendering a stem); returns a release function. */
      async load(names) {
        for (const n of names) if (!cache.has(n)) cache.set(n, await zip.read(`${resPrefix}${n}`));
        return () => names.forEach((n) => cache.delete(n));
      },
    };
  } catch (e) {
    if (e instanceof NeedsChoiceError) throw e;
    const err = new Error(`${label}: ${describeError(e)}`);
    err.cause = e;
    throw err;
  }
}

// One parse per input. Changing the baseline never re-reads the main project (and vice versa).
const slots = { project: null, baseline: null };
export function loadCached(file, role, opts = {}) {
  const key = `${fileSig(file)}|${opts.root ?? ''}`;
  const slot = slots[role];
  if (slot && slot.key === key) return slot.promise;
  const promise = openProjectZip(file, { ...opts, role });
  slots[role] = { key, promise };
  promise.catch(() => { if (slots[role]?.promise === promise) slots[role] = null; });
  return promise;
}
export const clearCache = (role) => { if (role) slots[role] = null; else { slots.project = null; slots.baseline = null; } };

export async function analyse(file, baselineFile, { sqlOptions, root, baselineRoot } = {}) {
  if (baselineFile && fileSig(file) === fileSig(baselineFile)) throw new SameFileError();
  const proj = await loadCached(file, 'project', { sqlOptions, root });
  const mixer = buildMixer(proj.project, proj.readResource, LOOKUPS);
  const lanes = findLanes(proj.project, proj.readResource);
  const targets = proposeTargets(lanes, mixer, automationKnown);
  let baseline = null;
  let baselineName = null;
  if (baselineFile) {
    const b = await loadCached(baselineFile, 'baseline', { sqlOptions, root: baselineRoot });
    baseline = collectBaseline(b.project, b.readResource, LOOKUPS);
    baselineName = `${b.root.name}.lpproj`;
  }
  const stems = planStems(proj.project, mixer);
  const allStems = planStems(proj.project, mixer, { includeSuperseded: true, includeUnused: true });

  let endBeat = 0;
  for (const t of proj.project.all('Track')) {
    if (t.data.duration >= 100) continue; // automation lanes run to the end of the song; ignore for length
    for (const p of trackPlacements(proj.project, t)) endBeat = Math.max(endBeat, p.start + p.duration);
  }
  const effectCount = [
    ...mixer.instruments.flatMap((i) => i.effects), ...mixer.groups.flatMap((g) => g.effects),
    ...mixer.buses.flatMap((b) => b.effects), ...mixer.master.effects,
  ].length;
  const warnings = [];
  targets.filter((t) => t.status === 'to confirm').forEach((t) => warnings.push(`Automation lane "${t.lane.title}": target not determined.`));
  mixer.unusedTracks.forEach((t) => warnings.push(`"${t.display}" (${t.colour}) is not used in the arrangement.`));
  mixer.superseded.forEach((s) => warnings.push(`"${s.track}" (${s.colour}) matches ${s.replacedBy}'s MIDI positions – treated as replaced by MIDI.`));
  mixer.instruments.filter((i) => i.state.note).forEach((i) => warnings.push(`${i.name}: ${i.state.note}`));
  mixer.instruments.forEach((i) => i.midiTracks.filter((t) => t.rate !== 1 || t.speed !== 1).forEach((t) => warnings.push(`${i.name}: the MIDI loop plays at ${t.rate * t.speed}× rate in Loopy (applied to the MIDI file). If it sounds an octave out, use Transpose in the Region inspector.`)));
  mixer.instruments.filter((i) => i.internal).forEach((i) => warnings.push(`${i.name}: ${i.internal.label} is on. If it stalls in Logic, ${i.internal.advice}.`));
  if (mixer.tempoSource === 'default') warnings.push('No tempo found in the project; assuming 120 bpm. Check the tempo before using the MIDI files.');
  else if (mixer.tempoSource === 'track') warnings.push('Tempo taken from the loops (the project clock has none).');
  const hasArrangement = endBeat > 0;
  if (!hasArrangement) warnings.push('This project has no arrangement, so there is nothing to place on a timeline. Stems and MIDI need an arrangement.');
  if (!baseline) warnings.push('No baseline project supplied, so tweaks from preset are not listed.');

  const ctx = { mixer, lanes, targets, baseline, lookups: LOOKUPS, odc, projectName: proj.root.name, baselineName };
  return {
    proj, mixer, lanes, targets, baseline, stems, allStems, ctx,
    summary: {
      name: proj.root.name, tempo: mixer.tempo, beatsPerBar: mixer.beatsPerBar,
      hasArrangement, bars: hasArrangement ? Math.ceil(endBeat / mixer.beatsPerBar) : 0,
      lengthSeconds: hasArrangement ? endBeat * 60 / mixer.tempo : 0,
      lengthText: hasArrangement ? `${Math.ceil(endBeat / mixer.beatsPerBar)} bars (${Math.floor(endBeat * 60 / mixer.tempo / 60)}:${String(Math.round(endBeat * 60 / mixer.tempo) % 60).padStart(2, '0')})` : 'No arrangement',
      tempoText: `${Number.isFinite(mixer.tempo) ? Math.round(mixer.tempo * 100) / 100 : '–'} bpm`,
      instruments: mixer.instruments.length, groups: mixer.groups.length, effects: effectCount,
      buses: mixer.buses.length, lanes: lanes.length, stems: stems.length, warnings,
    },
  };
}

export const manifestFor = (a, extra = {}) => generateManifest({ ...a.ctx, ...extra });

/**
 * Run the export. Returns [{ name, folder, blob, size }].
 * options: { stems, midi, automation, manifest, includeSuperseded, includeUnused }
 */
export async function runExport(a, options, onProgress = () => {}) {
  const out = [];
  const tasks = [];
  const stems = options.stems ? planStemsFor(a, options) : [];
  if (options.midi) tasks.push({ id: 'midi', w: 1 });
  if (options.automation) tasks.push({ id: 'auto', w: 1 });
  stems.forEach((s) => tasks.push({ id: `stem:${s.id}`, w: 6, stem: s }));
  if (options.manifest) tasks.push({ id: 'manifest', w: 1 });
  const totalW = tasks.reduce((s, t) => s + t.w, 0) || 1;
  let doneW = 0;
  const report = (label, frac = 0, cur = 0) => onProgress({ label, fraction: (doneW + cur * frac) / totalW });
  const rr = a.proj.readResource;
  let automationMapping = null;

  for (const t of tasks) {
    if (t.id === 'midi') {
      report('Writing instrument MIDI files…');
      for (const f of exportInstrumentMidi(a.proj.project, a.mixer, rr)) out.push(file(f.filename, 'MIDI', f.bytes, 'audio/midi'));
    } else if (t.id === 'auto') {
      report('Writing automation MIDI…');
      const f = exportAutomationMidi(a.proj.project, a.mixer, rr, a.targets);
      automationMapping = f.mapping;
      out.push(file(f.filename, 'Automation', f.bytes, 'audio/midi'));
    } else if (t.stem) {
      const s = t.stem;
      report(`Rendering ${s.filename}…`);
      const release = await a.proj.load([...new Set(s.tracks.map((x) => x.resource))]);
      const parts = [];
      const stats = {};
      for await (const chunk of renderStem(s, rr, { stats, onProgress: (f) => report(`Rendering ${s.filename}…`, 1, f * t.w) })) parts.push(chunk);
      release();
      const blob = new Blob(parts, { type: 'audio/wav' });
      out.push({ name: s.filename, folder: 'Audio', blob, size: blob.size, note: stats.clipped ? `${stats.clipped} samples clipped` : null, shifted: stats.shifted });
    } else if (t.id === 'manifest') {
      report('Writing manifest…');
      const md = manifestFor(a, { automationMapping });
      out.push(file(`${a.summary.name} – effects manifest.md`, '', new TextEncoder().encode(md), 'text/markdown'));
    }
    doneW += t.w;
    report('', 0);
  }
  onProgress({ label: 'Done', fraction: 1 });
  return out;
}

const planStemsFor = (a, o) => (o.includeSuperseded || o.includeUnused
  ? planStems(a.proj.project, a.mixer, { includeSuperseded: !!o.includeSuperseded, includeUnused: !!o.includeUnused })
  : a.stems);

function file(name, folder, bytes, type) {
  const blob = new Blob([bytes], { type });
  return { name, folder, blob, size: blob.size };
}

/** Bundle exported files into one zip Blob, streaming 8 MB at a time. WAVs are stored, text is deflated. */
export async function zipFiles(files, onProgress = () => {}, rootName = '') {
  const parts = [];
  let error = null;
  const zip = new Zip((err, chunk) => { if (err) error = err; else parts.push(chunk); });
  let i = 0;
  for (const f of files) {
    const path = [rootName, f.folder, f.name].filter(Boolean).join('/');
    const entry = /\.(wav|mid)$/i.test(f.name) ? new ZipPassThrough(path) : new ZipDeflate(path);
    zip.add(entry);
    const STEP = 8 * 1024 * 1024;
    for (let off = 0; off < f.size; off += STEP) {
      const buf = new Uint8Array(await f.blob.slice(off, Math.min(f.size, off + STEP)).arrayBuffer());
      entry.push(buf, off + STEP >= f.size);
    }
    if (f.size === 0) entry.push(new Uint8Array(0), true);
    onProgress(++i / files.length);
  }
  zip.end();
  if (error) throw error;
  return new Blob(parts, { type: 'application/zip' });
}
