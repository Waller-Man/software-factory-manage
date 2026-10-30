/** Standard ZIP writer and strict tar reader for the runtime-only bundle. */
import { deflateRawSync, gunzipSync } from 'node:zlib';
export function readTgz(bytes) {
  const tar = gunzipSync(bytes), entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512); if (h.every(x => x === 0)) break;
    const part = (start, end) => h.subarray(start, end).toString('utf8').split('\0')[0];
    const name = [part(345, 500), part(0, 100)].filter(Boolean).join('/');
    const size = parseInt(part(124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid tar entry');
    if (h[156] === 48 || h[156] === 0) {
      if (!name.startsWith('package/') || name.split('/').includes('..') || name.includes('\\')) throw new Error('Unsafe tar path');
      entries.push({ name: name.slice('package/'.length), data: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)) });
    } else if (h[156] !== 53 && h[156] !== 120) throw new Error('Unsupported tar entry type');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (new Set(entries.map(e => e.name)).size !== entries.length) throw new Error('Duplicate tar entry');
  return entries;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function createZip(entries) {
  const chunks = [], directory = []; let offset = 0;
  for (const { name, data } of entries) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error('Unsafe ZIP path');
    const filename = Buffer.from(name, 'utf8'), packed = deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    chunks.push(local, filename, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); offset += local.length + filename.length + packed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}
