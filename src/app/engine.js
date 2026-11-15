// Page-independent engine: analyse a zipped Loopy project, then export stems / MIDI / automation / manifest.
// Works in Safari and in Node (given Blob), so it is covered by the same tests as the library.
import { Zip, ZipPassThrough, ZipDeflate } from 'fflate';
import { openZip, findProjectRoot } from './zipfile.js';
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

export const LOOKUPS = { numaSounds, turnado: turnadoSub };

const isAudio = (n) => /\.(aiff?|wav|caf)$/i.test(n);

/** Open a zipped Loopy project: parse the database and preload every small (non-audio) resource. */
export async function openProjectZip(file, sqlOptions) {
  const zip = await openZip(file);
  const root = findProjectRoot(zip.names);
  if (!root) throw new Error('No Loopy project found in this zip (expected a folder ending in .lpproj containing Project.sqlite).');
  const sqlite = await zip.read(`${root.prefix}Project.sqlite`);
  const project = await loadProject(sqlite, sqlOptions);
  const cache = new Map();
  const resPrefix = `${root.prefix}Resources/`;
  for (const n of zip.names) {
    if (!n.startsWith(resPrefix) || n.endsWith('/') || isAudio(n)) continue;
    cache.set(n.slice(resPrefix.length), await zip.read(n));
  }
  return {
    zip, root, project, cache,
    audioNames: zip.names.filter((n) => n.startsWith(resPrefix) && isAudio(n)).map((n) => n.slice(resPrefix.length)),
    readResource: (name) => cache.get(name),
    /** Fetch audio files into the cache (call before rendering a stem); returns a release function. */
    async load(names) {
      for (const n of names) if (!cache.has(n)) cache.set(n, await zip.read(`${resPrefix}${n}`));
      return () => names.forEach((n) => cache.delete(n));
    },
  };
}

export async function analyse(file, baselineFile, { sqlOptions } = {}) {
  const proj = await openProjectZip(file, sqlOptions);
  const mixer = buildMixer(proj.project, proj.readResource, LOOKUPS);
  const lanes = findLanes(proj.project, proj.readResource);
  const targets = proposeTargets(lanes, mixer, automationKnown);
  let baseline = null;
  let baselineName = null;
  if (baselineFile) {
    const b = await openProjectZip(baselineFile, sqlOptions);
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
  mixer.unusedTracks.forEach((t) => warnings.push(`"${t.title}" (${t.colour}) is not used in the arrangement.`));
  mixer.superseded.forEach((s) => warnings.push(`"${s.track}" (${s.colour}) matches ${s.replacedBy}'s MIDI positions – treated as replaced by MIDI.`));
  mixer.instruments.filter((i) => i.state.note).forEach((i) => warnings.push(`${i.name}: ${i.state.note}`));
  if (!baseline) warnings.push('No baseline project supplied, so tweaks from preset are not listed.');

  const ctx = { mixer, lanes, targets, baseline, lookups: LOOKUPS, odc, projectName: proj.root.name, baselineName };
  return {
    proj, mixer, lanes, targets, baseline, stems, allStems, ctx,
    summary: {
      name: proj.root.name, tempo: mixer.tempo, beatsPerBar: mixer.beatsPerBar,
      bars: Math.ceil(endBeat / mixer.beatsPerBar), lengthSeconds: endBeat * 60 / mixer.tempo,
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
      out.push({ name: s.filename, folder: 'Stems', blob, size: blob.size, note: stats.clipped ? `${stats.clipped} samples clipped` : null, shifted: stats.shifted });
    } else if (t.id === 'manifest') {
      report('Writing manifest…');
      const md = manifestFor(a, { automationMapping });
      out.push(file(`${a.summary.name} – effects manifest.md`, 'Manifest', new TextEncoder().encode(md), 'text/markdown'));
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
export async function zipFiles(files, onProgress = () => {}) {
  const parts = [];
  let error = null;
  const zip = new Zip((err, chunk) => { if (err) error = err; else parts.push(chunk); });
  let i = 0;
  for (const f of files) {
    const entry = /\.(wav|mid)$/i.test(f.name) ? new ZipPassThrough(`${f.folder}/${f.name}`) : new ZipDeflate(`${f.folder}/${f.name}`);
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
