// Loads a Loopy Pro project's Project.sqlite into an in-memory object graph.
// No Node-only APIs: takes bytes in, returns plain objects.
import initSqlJs from 'sql.js';

const dec = new TextDecoder();

export async function openSqlite(bytes, sqlOptions) {
  const SQL = await initSqlJs(sqlOptions);
  return new SQL.Database(bytes);
}

/** Convert a base64 string to Uint8Array (works in Node and browsers). */
export function b64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Parse Project.sqlite bytes.
 * Returns { objects: Map<id,{id,type,data}>, meta, get(ref), all(type), refs(list) }.
 */
export async function loadProject(sqliteBytes, sqlOptions) {
  const db = await openSqlite(sqliteBytes, sqlOptions);
  const objects = new Map();
  const res = db.exec('select id, type, contents from objects');
  for (const [id, type, contents] of res[0]?.values ?? []) {
    let data = null;
    try {
      data = JSON.parse(typeof contents === 'string' ? contents : dec.decode(contents));
    } catch {
      data = null;
    }
    objects.set(id, { id, type, data });
  }
  const meta = {};
  try {
    for (const [k, v] of db.exec('select * from meta')[0]?.values ?? []) meta[k] = v;
  } catch { /* meta optional */ }
  db.close();

  const isRef = (r) => r && typeof r === 'object' && r._value !== undefined && r._type && r._type !== 'Set' && r._type !== 'Data' && r._type !== 'Color';
  const get = (ref) => {
    if (ref == null) return null;
    const id = typeof ref === 'number' ? ref : ref._value;
    return objects.get(id) ?? null;
  };
  /** Resolve a list (array or Set wrapper) of refs to objects, dropping dangling refs. */
  const refs = (list) => {
    if (!list) return [];
    const arr = Array.isArray(list) ? list : list._type === 'Set' ? list._value : [];
    return arr.map(get).filter(Boolean);
  };
  const all = (type) => [...objects.values()].filter((o) => o.type === type);
  return { objects, meta, get, refs, all, isRef };
}

/** Colour channel name from RGBA (0–1), nearest match in the palette. */
export function colourName(rgba, palette = COLOUR_PALETTE) {
  let best = null;
  for (const p of palette) {
    const d = (p.rgb[0] - rgba[0]) ** 2 + (p.rgb[1] - rgba[1]) ** 2 + (p.rgb[2] - rgba[2]) ** 2;
    if (!best || d < best.d) best = { d, name: p.name };
  }
  return best.name;
}

// Provisional palette – to be verified against Loopy's own names (see data/colours.json once filled in).
export const COLOUR_PALETTE = [
  { name: 'Orange', rgb: [0.996, 0.541, 0.035] },
  { name: 'Yellow', rgb: [1, 0.878, 0.09] },
  { name: 'Blue', rgb: [0.22, 0.663, 0.871] },
  { name: 'Pink', rgb: [0.965, 0.094, 0.6] },
  { name: 'Lime', rgb: [0.675, 0.973, 0.11] },
  { name: 'Violet', rgb: [0.475, 0.231, 0.71] },
  { name: 'Aqua', rgb: [0.196, 0.973, 0.855] },
  { name: 'Royal Blue', rgb: [0.22, 0.431, 0.871] },
  { name: 'Green', rgb: [0.086, 0.965, 0.09] },
  { name: 'Amber', rgb: [0.902, 0.357, 0.173] },
  { name: 'Purple', rgb: [0.725, 0.314, 0.89] },
  { name: 'Red', rgb: [0.855, 0.027, 0.259] },
  { name: 'Light Pink', rgb: [1, 0.51, 0.773] },
];
