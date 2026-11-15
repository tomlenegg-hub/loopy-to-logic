// Decode instrument (PluginAudioSource) state: preset/kit name and flat parameter map.
import { parseBplist, isBplist } from './bplist.js';
import { b64ToBytes } from './project.js';
import { latin1, tidyName } from './effects.js';

export function instrumentStateBytes(inst, readResource) {
  const d = inst.data;
  if (d.state?._type === 'Data') return b64ToBytes(d.state._value);
  if (d.resourcePath) return readResource?.(d.resourcePath);
  return undefined;
}

const decodeXmlParams = (text) => {
  const params = {};
  for (const m of text.matchAll(/<PARAM id="([^"]+)" value="([^"]*)"/g)) params[m[1]] = Number(m[2]);
  return params;
};

/**
 * @param lookups { numaSounds: {uuid: name} }
 * Returns { kind, preset, bank, params, soundId?, note? }
 */
export function decodeInstrument(inst, readResource, lookups = {}) {
  const name = inst.data.moduleName ?? '';
  const bytes = instrumentStateBytes(inst, readResource);
  const base = { kind: 'unknown', preset: null, bank: null, params: {} };
  if (!bytes || !isBplist(bytes)) return base;
  const root = parseBplist(bytes);
  const au = root['AU State'] ?? root.Components?.[0]?.State?.['AU State'] ?? {};

  if (/J6/i.test(name) || au.appStatePreset) {
    const ap = au.appStatePreset ?? {};
    const params = {};
    for (const p of ap.parameterValues ?? []) params[String(p.identifier).replace(/^neon/, '')] = p.value;
    return {
      kind: 'j6',
      preset: tidyName((ap.name ?? '').replace(/\*+$/, '')) || null,
      bank: au.selectedBankName ?? null,
      params,
    };
  }
  if (/DigiStix/i.test(name) || au.preset_name !== undefined) {
    const params = {};
    for (const [k, v] of Object.entries(au)) {
      if (k === 'preset_name') continue;
      if (typeof v === 'number' || typeof v === 'boolean') params[k] = Number(v);
    }
    return { kind: 'digistix', preset: au.preset_name ?? null, bank: null, params };
  }
  if (/Numa/i.test(name)) {
    const text = au.jucePluginState instanceof Uint8Array ? latin1(au.jucePluginState) : '';
    const id = text.match(/SELECTED_UUID_ID="([^"]+)"/)?.[1] ?? null;
    const known = id ? lookups.numaSounds?.[id] : null;
    return {
      kind: 'numa', preset: known ?? null, bank: null, soundId: id,
      params: decodeXmlParams(text),
      note: known ? null : `Sound ID ${id ?? 'unknown'} – not in lookup; note the sound by hand`,
    };
  }
  return base;
}
