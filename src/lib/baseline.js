// Compare instances against an untouched baseline project (matched by plug-in + preset name).
import { decodeEffect } from './effects.js';
import { decodeInstrument } from './instruments.js';

export const TOLERANCE = 1e-3;

/** Collect every effect and instrument in a project, decoded. */
export function collectBaseline(project, readResource, lookups = {}) {
  const effects = project.all('Effect').map(decodeEffect);
  const instruments = project.all('PluginAudioSource').map((i) => ({
    module: i.data.moduleName, ...decodeInstrument(i, readResource, lookups),
  }));
  return { effects, instruments };
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : null);

/** Diff two flat parameter maps. Keys on only one side are ignored (newer plug-in versions add parameters). */
export function diffParams(current, base, tol = TOLERANCE) {
  const changes = [];
  for (const key of Object.keys(current)) {
    if (!(key in base)) continue;
    const a = num(base[key]);
    const b = num(current[key]);
    if (a === null || b === null) continue;
    if (Math.abs(a - b) > tol) changes.push({ key, from: a, to: b });
  }
  return changes;
}

/** Find the baseline effect matching this one (same plug-in; same preset when it has one). */
export function matchEffect(effect, baseline) {
  const same = baseline.effects.filter((b) => b.title === effect.title);
  if (effect.preset) return same.find((b) => b.preset === effect.preset) ?? null;
  return same.find((b) => !b.preset) ?? same[0] ?? null;
}

const sameModule = (a, b) => a?.toLowerCase() === b?.toLowerCase();

/** Match by plug-in + preset. Falls back to plug-in alone (flagged approximate), e.g. Numa where the sound is only an ID. */
export function matchInstrument(inst, baseline) {
  const exact = baseline.instruments.find((b) => sameModule(b.module, inst.module) && b.preset && b.preset === inst.state.preset);
  if (exact) return { match: exact, approximate: false };
  const loose = baseline.instruments.find((b) => sameModule(b.module, inst.module));
  return loose ? { match: loose, approximate: true } : { match: null };
}

export function effectChanges(effect, baseline) {
  const m = matchEffect(effect, baseline);
  if (!m) return { matched: false, changes: [] };
  return { matched: true, preset: m.preset, changes: diffParams(effect.params, m.params) };
}

export function instrumentChanges(inst, baseline) {
  const { match, approximate } = matchInstrument(inst, baseline);
  if (!match) return { matched: false, changes: [] };
  return { matched: true, approximate: !!approximate, changes: diffParams(inst.state.params, match.params) };
}
