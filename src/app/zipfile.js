// Random-access zip reader over a Blob/File: reads the central directory, then inflates one entry at a time.
// Keeps memory low for 100–200 MB Loopy projects. Supports stored and deflate entries (not zip64).
import { inflateSync } from 'fflate';

const dec = new TextDecoder('utf-8');

async function readBytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

export async function openZip(blob) {
  const size = blob.size;
  const tailLen = Math.min(size, 65557);
  const tail = await readBytes(blob, size - tailLen, size);
  const tdv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This does not look like a zip file.');
  const count = tdv.getUint16(eocd + 10, true);
  const cdSize = tdv.getUint32(eocd + 12, true);
  const cdOffset = tdv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported.');

  const cd = await readBytes(blob, cdOffset, cdOffset + cdSize);
  const cdv = new DataView(cd.buffer);
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cdv.getUint32(p, true) !== 0x02014b50) break;
    const flags = cdv.getUint16(p + 8, true);
    const method = cdv.getUint16(p + 10, true);
    const compSize = cdv.getUint32(p + 20, true);
    const uncompSize = cdv.getUint32(p + 24, true);
    const nameLen = cdv.getUint16(p + 28, true);
    const extraLen = cdv.getUint16(p + 30, true);
    const commentLen = cdv.getUint16(p + 32, true);
    const localOffset = cdv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { name, method, compSize, uncompSize, localOffset, encrypted: !!(flags & 1) });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: [...entries.keys()],
    has: (n) => entries.has(n),
    size: (n) => entries.get(n)?.uncompSize,
    /** Inflate one entry. Returns undefined if the entry does not exist. */
    async read(name) {
      const e = entries.get(name);
      if (!e) return undefined;
      if (e.encrypted) throw new Error(`${name} is encrypted.`);
      const lh = await readBytes(blob, e.localOffset, e.localOffset + 30);
      const ldv = new DataView(lh.buffer);
      const dataStart = e.localOffset + 30 + ldv.getUint16(26, true) + ldv.getUint16(28, true);
      const raw = await readBytes(blob, dataStart, dataStart + e.compSize);
      if (e.method === 0) return raw;
      if (e.method === 8) return inflateSync(raw, { out: new Uint8Array(e.uncompSize) });
      throw new Error(`Unsupported zip compression method ${e.method} in ${name}.`);
    },
  };
}

/** Find the .lpproj folder prefix (ignoring __MACOSX), e.g. "Adabadaba Dub.lpproj/". */
export function findProjectRoot(names) {
  const hit = names.find((n) => !n.startsWith('__MACOSX/') && /(^|\/)[^/]*\.lpproj\/Project\.sqlite$/.test(n));
  if (!hit) return null;
  const prefix = hit.slice(0, hit.length - 'Project.sqlite'.length);
  const folder = prefix.replace(/\/$/, '').split('/').pop();
  return { prefix, name: folder.replace(/\.lpproj$/, '') };
}
