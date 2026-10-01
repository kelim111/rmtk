/* =========================================================================
   RPG Maker 2000 / 2003 解析器（LCF 二进制格式）
     文件结构： <magic 字符串> <0x00> [chunk...]
     每个 chunk：<BER id> <BER 长度> <数据>；长度为 0 表示后面跟一段嵌套 chunk 列表
     整数是 7bit 大端变长（和 MIDI 的 VLQ 一样）

   ⚠ 2000/2003 的字段号各家文档说法不完全一致，本解析器做的是「尽力解析」：
     地图尺寸、地图名、事件名/坐标、事件指令里的文字与数字参数都能拿到，
     指令编号保留原样（10110 = 显示文章 之类），并标记为 experimental。
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';

const MAGICS = {
  LcfMapUnit: 'map',
  LcfMapTree: 'tree',
  LcfDataBase: 'database',
  LcfGame: 'save'
};

export function readBer(buf, pos) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const b = buf[pos++];
    if (b === undefined) break;
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return [value, pos];
}

export function readChunkList(buf, pos, end) {
  const chunks = [];
  while (pos < end) {
    let id, size;
    [id, pos] = readBer(buf, pos);
    if (id === 0) return { chunks, pos };
    [size, pos] = readBer(buf, pos);
    if (size === 0) {
      const nested = readChunkList(buf, pos, end);
      chunks.push({ id, size: 0, chunks: nested.chunks });
      pos = nested.pos;
    } else {
      chunks.push({ id, size, data: buf.subarray(pos, pos + size) });
      pos += size;
    }
  }
  return { chunks, pos };
}

export function isLcf(buf) {
  const head = buf.subarray(0, 16).toString('latin1');
  return Object.keys(MAGICS).some((m) => head.startsWith(m));
}

export function readLcf(buf) {
  const nul = buf.indexOf(0);
  const magic = buf.subarray(0, nul === -1 ? 16 : nul).toString('latin1');
  const kind = MAGICS[magic] || 'unknown';
  let pos = nul === -1 ? 12 : nul + 1;
  let parsed = null;
  // 有的版本在这里还塞了个总长度，先按「没有」试一次，失败再跳过它
  try { parsed = readChunkList(buf, pos, buf.length); } catch { parsed = null; }
  if (!parsed || parsed.chunks.length === 0) {
    let skipped;
    [, skipped] = readBer(buf, pos);
    parsed = readChunkList(buf, skipped, buf.length);
  }
  return { magic, kind, chunks: parsed.chunks };
}

const str = (b) => (b ? b.toString('utf8') : '');

function readString(buf, pos) {
  let len;
  [len, pos] = readBer(buf, pos);
  return [buf.subarray(pos, pos + len).toString('utf8'), pos + len];
}

function readIntList(buf) {
  let pos = 0, count, v;
  const out = [];
  [count, pos] = readBer(buf, pos);
  for (let i = 0; i < count && pos < buf.length; i++) {
    [v, pos] = readBer(buf, pos);
    out.push(v);
  }
  return out;
}

/* ---------------------------------------------------------------- 地图树 */

export function parseMapTree(buf) {
  const { chunks } = readLcf(buf);
  const tree = [];
  const walk = (list, parent) => {
    for (const c of list) {
      if (c.chunks) {
        const fields = new Map(c.chunks.map((x) => [x.id, x]));
        const nameField = fields.get(1);
        const idxField = fields.get(5);
        const node = {
          name: nameField ? readString(nameField.data, 0)[0] : '',
          mapId: idxField ? readIntList(idxField.data)[0] : undefined,
          parent,
          children: []
        };
        tree.push(node);
        walk(c.chunks, node);
      }
    }
  };
  walk(chunks, null);
  return tree;
}

/* ------------------------------------------------------------------ 地图 */

export function parseMap(buf) {
  const { chunks } = readLcf(buf);
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const map = { width: 0, height: 0, events: [] };
  // 2 / 3 是宽高（各家文档一致）
  if (byId.get(2)) map.width = readIntList(byId.get(2).data)[0] || 0;
  if (byId.get(3)) map.height = readIntList(byId.get(3).data)[0] || 0;
  if (!map.width && byId.get(1)) map.width = readIntList(byId.get(1).data)[0] || 0;
  if (!map.height && byId.get(2) && map.width) map.height = readIntList(byId.get(2).data)[0] || 0;

  for (const c of chunks) {
    if (c.id < 71 || !c.chunks) continue;
    const fields = new Map(c.chunks.map((x) => [x.id, x]));
    const ev = { id: c.id - 71 + 1, name: '', x: 0, y: 0, pages: [] };
    if (fields.get(1)) ev.name = readString(fields.get(1).data, 0)[0];
    if (fields.get(2)) ev.x = readIntList(fields.get(2).data)[0] ?? 0;
    if (fields.get(3)) ev.y = readIntList(fields.get(3).data)[0] ?? 0;
    const pages = fields.get(5);
    if (pages && pages.chunks) {
      for (const p of pages.chunks) {
        if (!p.chunks) continue;
        const pf = new Map(p.chunks.map((x) => [x.id, x]));
        const commands = [];
        const listChunk = pf.get(11) || pf.get(12);
        if (listChunk && listChunk.chunks) {
          for (const cmd of listChunk.chunks) {
            if (!cmd.chunks) continue;
            const cf = new Map(cmd.chunks.map((x) => [x.id, x]));
            const code = cf.get(1) ? readIntList(cf.get(1).data)[0] ?? 0 : 0;
            const indent = cf.get(2) ? readIntList(cf.get(2).data)[0] ?? 0 : 0;
            const text = cf.get(3) ? readString(cf.get(3).data, 0)[0] : '';
            const ints = cf.get(4) ? readIntList(cf.get(4).data) : [];
            commands.push({ code, indent, text, ints });
          }
        }
        ev.pages.push({ commands });
      }
    }
    map.events.push(ev);
  }
  return map;
}

/* --------------------------------------------------------------- 数据库 */

const DB_CHUNKS = {
  11: 'actors', 12: 'skills', 13: 'items', 14: 'enemies', 15: 'troops',
  16: 'terrains', 17: 'attributes', 18: 'states', 19: 'animations',
  20: 'chipsets', 21: 'commonEvents'
};

export function parseDatabase(buf) {
  const { chunks } = readLcf(buf);
  const db = {};
  for (const c of chunks) {
    const key = DB_CHUNKS[c.id];
    if (!key || !c.chunks) continue;
    const rows = [];
    for (const row of c.chunks) {
      if (!row.chunks) continue;
      const fields = new Map(row.chunks.map((x) => [x.id, x]));
      const nameField = fields.get(1) || fields.get(2);
      rows.push({
        id: row.id === 0 ? undefined : row.id,
        name: nameField ? readString(nameField.data, 0)[0] : ''
      });
    }
    db[key] = rows;
  }
  return db;
}

/* ------------------------------------------------------- 组装成统一工程模型 */

const TEXT_CODES = new Set([10110, 10111, 10112, 10113, 10114]);   // 2000 的显示文章系列
const TRANSFER_CODES = new Set([20110, 20111, 20112]);            // 场所移动

export function parseLcfProject(meta) {
  const { root, lcf } = meta;
  const mapTree = lcf.lmt ? parseMapTree(fs.readFileSync(lcf.lmt)) : [];
  const db = lcf.ldb ? parseDatabase(fs.readFileSync(lcf.ldb)) : {};
  const treeNames = new Map();
  for (const node of mapTree) if (node.mapId) treeNames.set(node.mapId, node.name);

  const maps = [];
  for (const file of (lcf.lmu || []).sort()) {
    const id = Number((path.basename(file).match(/(\d+)/) || [])[1] || 0);
    let parsed;
    try { parsed = parseMap(fs.readFileSync(file)); } catch { continue; }
    maps.push({
      id,
      name: treeNames.get(id) || '',
      width: parsed.width,
      height: parsed.height,
      tilesetId: 0,
      note: '',
      bgm: null, bgs: null,
      events: parsed.events.map((ev) => ({
        id: ev.id, name: ev.name, x: ev.x, y: ev.y, note: '',
        pages: ev.pages.map((p) => ({
          conditions: {}, image: {}, trigger: 0,
          commands: p.commands.map((c) => ({
            code: c.code, indent: c.indent,
            params: c.ints,
            kind: TEXT_CODES.has(c.code) ? 'text'
              : TRANSFER_CODES.has(c.code) ? 'transfer'
                : c.code === 12010 ? 'setSwitch'
                  : c.code === 12020 ? 'setVariable' : 'other',
            text: TEXT_CODES.has(c.code) ? c.text : undefined,
            raw2000: c
          }))
        }))
      }))
    });
  }

  const nameOf = (list) => (list || []).map((x) => x.name).filter(Boolean);
  return {
    engine: meta.engine,
    label: meta.label,
    root,
    dataDir: root,
    system: {
      title: path.basename(root),
      startMapId: maps[0]?.id ?? 1, startX: 0, startY: 0,
      partyMembers: [], currency: '',
      switches: [], variables: []
    },
    maps,
    database: {
      actors: (db.actors || []).map((x) => ({ ...x })),
      items: (db.items || []).map((x) => ({ ...x })),
      enemies: (db.enemies || []).map((x) => ({ ...x })),
      skills: (db.skills || []).map((x) => ({ ...x })),
      troops: (db.troops || []).map((x) => ({ ...x })),
      weapons: [], armors: [], states: [], classes: [], tilesets: []
    },
    commonEvents: (db.commonEvents || []).map((x) => ({ id: x.id, name: x.name, commands: [] })),
    experimental: true,
    notes: [
      '2000/2003 的字段定义在各版本之间有差异，本工具按通用约定解析。',
      '事件指令保留了原编号（10110 显示文章 / 20110 场所移动 / 12010 开关 / 12020 变量）。'
    ],
    mapNames: nameOf(db.actors)
  };
}
