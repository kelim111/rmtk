/* =========================================================================
   极简 ZIP 解包（零依赖）：只用 node 自带的 zlib
   支持 store(0) 与 deflate(8) 两种压缩方式 —— 覆盖 GitHub / Windows 压缩出来的 zip。
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function readZipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是一个 zip 文件（找不到目录结尾标记）');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, localOff });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buf, entry) {
  const p = entry.localOff;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('zip 局部头损坏：' + entry.name);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${entry.method}（文件：${entry.name}）`);
}

/** 解压到目录（防目录穿越） */
export function unzipToDir(buf, dir) {
  const entries = readZipEntries(buf);
  let files = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const safe = path.normalize(e.name).replace(/^(\.\.[/\\])+/, '');
    const target = path.join(dir, safe);
    if (!target.startsWith(path.resolve(dir))) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readZipEntry(buf, e));
    files++;
  }
  return { files, entries: entries.length };
}

/** 找 zip 里真正的工程根目录（有的压缩包会多套一层文件夹） */
export function findProjectRoot(base) {
  const isRoot = (dir) => {
    const names = (() => { try { return fs.readdirSync(dir).map((n) => n.toLowerCase()); } catch { return []; } })();
    if (names.includes('data') || names.includes('graphics') || names.includes('audio')) return true;
    if (names.includes('rpg_rt.ldb') || names.includes('rpg_rt.lmt')) return true;
    return false;
  };
  if (isRoot(base)) return base;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (isRoot(full)) return full;
      stack.push(full);
    }
  }
  return base;
}

/* ------------------------------------------------------------ 打 zip（store） */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

export function writeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0, dosDate = 0x21; // 固定时间戳，够用
  for (const [name, contentRaw] of Object.entries(files)) {
    const content = Buffer.isBuffer(contentRaw) ? contentRaw : Buffer.from(String(contentRaw), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(content);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);            // store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    chunks.push(local, content);
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(content.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + content.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}
