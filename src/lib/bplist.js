// Minimal binary plist (bplist00) reader. Browser-safe (no Buffer). Returns plain JS values:
// dict -> object, array -> array, data -> Uint8Array, date -> Date, UID -> {UID: n}.
export function isBplist(bytes) {
  return bytes.length > 8 && bytes[0] === 0x62 && bytes[1] === 0x70 && bytes[2] === 0x6c && bytes[3] === 0x69 && bytes[4] === 0x73 && bytes[5] === 0x74;
}

export function parseBplist(bytes) {
  if (!isBplist(bytes)) throw new Error('Not a binary plist');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tl = bytes.length - 32;
  const offSize = bytes[tl + 6];
  const refSize = bytes[tl + 7];
  const numObjects = Number(dv.getBigUint64(tl + 8));
  const top = Number(dv.getBigUint64(tl + 16));
  const tableOff = Number(dv.getBigUint64(tl + 24));
  const readUInt = (pos, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + bytes[pos + i];
    return v;
  };
  const offsetOf = (i) => readUInt(tableOff + i * offSize, offSize);
  const dec = new TextDecoder('utf-8');
  const cache = new Map();

  function lenAt(pos, info) {
    if (info !== 0xf) return { len: info, start: pos + 1 };
    const intMarker = bytes[pos + 1];
    const n = 1 << (intMarker & 0xf);
    return { len: readUInt(pos + 2, n), start: pos + 2 + n };
  }

  function parseObj(i) {
    if (cache.has(i)) return cache.get(i);
    const pos = offsetOf(i);
    const marker = bytes[pos];
    const type = marker >> 4;
    const info = marker & 0xf;
    let val;
    switch (type) {
      case 0x0:
        val = info === 8 ? false : info === 9 ? true : null;
        break;
      case 0x1: {
        const n = 1 << info;
        if (n <= 6) val = readUInt(pos + 1, n);
        else if (n === 8) val = Number(dv.getBigInt64(pos + 1));
        else val = Number(dv.getBigInt64(pos + 1 + n - 8));
        break;
      }
      case 0x2:
        val = info === 2 ? dv.getFloat32(pos + 1) : dv.getFloat64(pos + 1);
        break;
      case 0x3:
        val = new Date((dv.getFloat64(pos + 1) + 978307200) * 1000);
        break;
      case 0x4: {
        const { len, start } = lenAt(pos, info);
        val = bytes.slice(start, start + len);
        break;
      }
      case 0x5: {
        const { len, start } = lenAt(pos, info);
        let s = '';
        for (let k = 0; k < len; k++) s += String.fromCharCode(bytes[start + k]);
        val = s;
        break;
      }
      case 0x6: {
        const { len, start } = lenAt(pos, info);
        val = new TextDecoder('utf-16be').decode(bytes.subarray(start, start + len * 2));
        break;
      }
      case 0x8:
        val = { UID: readUInt(pos + 1, info + 1) };
        break;
      case 0xa:
      case 0xc: {
        const { len, start } = lenAt(pos, info);
        val = [];
        for (let k = 0; k < len; k++) val.push(parseObj(readUInt(start + k * refSize, refSize)));
        break;
      }
      case 0xd: {
        const { len, start } = lenAt(pos, info);
        val = {};
        for (let k = 0; k < len; k++) {
          const key = parseObj(readUInt(start + k * refSize, refSize));
          val[key] = parseObj(readUInt(start + (len + k) * refSize, refSize));
        }
        break;
      }
      default:
        throw new Error(`Unsupported bplist type 0x${type.toString(16)}`);
    }
    cache.set(i, val);
    return val;
  }
  if (numObjects < 1) return null;
  return parseObj(top);
}
