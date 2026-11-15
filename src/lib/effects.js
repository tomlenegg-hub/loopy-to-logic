// Decode a Loopy `Effect` object: plug-in name, preset, parameters, Turnado slots.
import { parseBplist, isBplist } from './bplist.js';
import { b64ToBytes } from './project.js';

export const latin1 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
};

/** Typographic tidy for display: "22 - MXR" -> "22 – MXR" (en dash, never em dash). */
export const tidyName = (s) => s?.replace(/\s+-\s+/g, ' – ').replace(/\s{2,}/g, ' ').trim();

const NO_PRESET = 'no preset (fresh instance)';

function findPresetName(au) {
  if (!au) return null;
  if (typeof au.presetName === 'string' && au.presetName) return au.presetName; // BLEASS
  for (const k of ['jucePluginState', 'data']) {
    const v = au[k];
    if (v instanceof Uint8Array) {
      const m = latin1(v).match(/presetName="([^"]*)"/i);
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

/** Turnado: eight u32-LE-length-prefixed ASCII strings, one per slot (sub-preset names). */
export function parseTurnado(blob) {
  if (!(blob instanceof Uint8Array)) return { slots: [], preset: null };
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const strings = [];
  for (let i = 4; i + 4 <= blob.length - 1; i++) {
    const len = dv.getUint32(i, true);
    if (len < 3 || len > 40 || i + 4 + len > blob.length) continue;
    const bytes = blob.subarray(i + 4, i + 4 + len);
    let ok = true;
    for (const b of bytes) if (b < 32 || b > 126) { ok = false; break; }
    // Reject strings that run straight into more text-like noise (cheap sanity check)
    if (ok && /^[A-Za-z][A-Za-z0-9 #._\-+&']*$/.test(latin1(bytes))) {
      strings.push({ at: i, text: latin1(bytes) });
      i += 3 + len;
    }
  }
  return { strings };
}

export function decodeEffect(effectObj) {
  const d = effectObj.data;
  const raw = d.dictionaryRepresentation;
  let dict = null;
  try {
    dict = parseBplist(raw?._type === 'Data' ? b64ToBytes(raw._value) : raw);
  } catch { /* leave null */ }
  const comp = dict?.Components?.[0] ?? {};
  const state = comp.State ?? {};
  let au = state['AU State'] ?? null;
  const title = comp.Title ?? 'Unknown';
  let preset = findPresetName(au);
  const out = {
    id: effectObj.id,
    title,
    enabled: d.enabled !== false,
    params: comp.Parameters ?? {},
    auIndex: state['AU Preset'],
    preset: preset ? tidyName(preset) : null,
    au,
  };
  if (/^Turnado/i.test(title)) {
    const blob = au?.['Turnado-DATA-KEY'];
    out.turnado = parseTurnado(blob);
  }
  out.presetLabel = out.preset ?? NO_PRESET;
  return out;
}
