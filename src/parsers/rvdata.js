/* =========================================================================
   RPG Maker XP / VX / VX Ace 解析器（.rxdata / .rvdata 都是 Ruby Marshal）
   三个版本的类结构差别不大，这里用一张「字段映射表」照顾差异：
     - 开关/变量名字：VX 是数组；XP 是 RPG::System::Words（里面再套 @names）
     - 事件指令：XP 的 101 本身就带文字，VX/Ace 是 101 表头 + 401 文字
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { load, getIv, strVal, tableParse } from './marshal.js';
import { normalizeCommands } from './mv.js';

const listDir = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

function readRV(dataDir, base, ext) {
  const files = listDir(dataDir);
  const want = (base + ext).toLowerCase();
  const hit = files.find((f) => f.toLowerCase() === want);
  if (!hit) return null;
  try { return load(fs.readFileSync(path.join(dataDir, hit))); } catch (e) {
    return { __error: e.message };
  }
}

function arrayOf(obj) {
  if (!obj) return [];
  if (Array.isArray(obj.__arr)) return obj.__arr;
  const data = getIv(obj, '@data');
  if (data && Array.isArray(data.__arr)) return data.__arr;
  return [];
}

function nameList(sys, key, engine) {
  // key: '@switches' | '@variables'
  const raw = getIv(sys, key);
  if (!raw) return [];
  if (Array.isArray(raw.__arr)) return raw.__arr.map((s) => strVal(s));
  const names = getIv(raw, '@names');
  if (names && Array.isArray(names.__arr)) return names.__arr.map((s) => strVal(s));
  return [];
}

function num(o) { return typeof o === 'number' ? o : Number(o ?? 0); }

export function parseMarshalProject(meta) {
  const { root, dataDir, engine } = meta;
  const ext = engine === 'XP' ? '.rxdata' : '.rvdata';

  const sys = readRV(dataDir, 'System', ext) || {};
  if (sys.__error) throw new Error(`System${ext} 读不出来：${sys.__error}`);
  const mapInfos = readRV(dataDir, 'MapInfos', ext);

  const infoById = new Map();
  if (mapInfos && Array.isArray(mapInfos.__hash)) {
    for (const [k, v] of mapInfos.__hash) {
      infoById.set(num(k), { name: strVal(getIv(v, '@name')), order: num(getIv(v, '@order')) });
    }
  } else if (mapInfos && Array.isArray(mapInfos.__arr)) {
    mapInfos.__arr.forEach((v, i) => {
      if (!v || !v.__iv) return;
      infoById.set(i, { name: strVal(getIv(v, '@name')), order: num(getIv(v, '@order')) });
    });
  }

  const mapFiles = listDir(dataDir)
    .map((f) => ({ f, m: new RegExp(`^Map(\\d+)\\${ext}$`, 'i').exec(f) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));

  const maps = [];
  for (const { f, m } of mapFiles) {
    const id = Number(m[1]);
    const raw = readRV(dataDir, 'Map' + String(id).padStart(3, '0'), ext) ||
      (() => { try { return load(fs.readFileSync(path.join(dataDir, f))); } catch { return null; } })();
    if (!raw || raw.__error) continue;
    maps.push(normalizeMap(id, raw, infoById.get(id), engine, path.join(dataDir, f)));
  }

  const database = {
    actors: readDb(dataDir, 'Actors', ext, engine),
    classes: readDb(dataDir, 'Classes', ext, engine),
    items: readDb(dataDir, 'Items', ext, engine),
    weapons: readDb(dataDir, 'Weapons', ext, engine),
    armors: readDb(dataDir, 'Armors', ext, engine),
    skills: readDb(dataDir, 'Skills', ext, engine),
    states: readDb(dataDir, 'States', ext, engine),
    enemies: readDb(dataDir, 'Enemies', ext, engine),
    troops: readDb(dataDir, 'Troops', ext, engine),
    tilesets: readDb(dataDir, 'Tilesets', ext, engine)
  };

  const commonRaw = readDb(dataDir, 'CommonEvents', ext, engine, true);
  const commonEvents = (commonRaw || []).map((ce, i) => (ce ? {
    id: num(getIv(ce, '@id')) || i,
    name: strVal(getIv(ce, '@name')),
    trigger: num(getIv(ce, '@trigger')),
    switchId: num(getIv(ce, '@switch_id')),
    commands: normalizeCommands(decodeCommands(getIv(ce, '@list')), engine)
  } : null)).filter(Boolean);

  return {
    engine,
    label: meta.label,
    root,
    dataDir,
    system: {
      title: strVal(getIv(sys, '@game_title')),
      versionId: num(getIv(sys, '@version_id')),
      startMapId: num(getIv(sys, '@start_map_id')),
      startX: num(getIv(sys, '@start_x')),
      startY: num(getIv(sys, '@start_y')),
      partyMembers: arrayOf(getIv(sys, '@party_members')).map(num),
      currency: strVal(getIv(sys, '@currency_unit')),
      switches: nameList(sys, '@switches', engine).map((name, i) => ({ id: i, name })),
      variables: nameList(sys, '@variables', engine).map((name, i) => ({ id: i, name })),
      raw: sys
    },
    maps,
    database,
    commonEvents,
    experimental: engine === 'XP'
  };
}

function readDb(dataDir, base, ext, engine, keepEmpty) {
  const raw = readRV(dataDir, base, ext);
  if (!raw) return [];
  if (raw.__error) return [];
  const arr = Array.isArray(raw.__arr) ? raw.__arr : arrayOf(getIv(raw, '@data'));
  const out = [];
  arr.forEach((o, i) => {
    if (!o || !o.__iv) { if (keepEmpty) out.push(null); return; }
    const name = strVal(getIv(o, '@name'));
    if (!name && !keepEmpty) return;
    out.push({
      id: num(getIv(o, '@id')) || i,
      name,
      iconIndex: getIv(o, '@icon_index'),
      description: strVal(getIv(o, '@description')) || strVal(getIv(o, '@note')),
      atk: getIv(o, '@atk'),
      price: getIv(o, '@price'),
      raw: o
    });
  });
  return out;
}

function normalizeMap(id, raw, info, engine, file) {
  const map = {
    id,
    file,
    raw,
    name: info?.name || strVal(getIv(raw, '@display_name')) || '',
    width: num(getIv(raw, '@width')),
    height: num(getIv(raw, '@height')),
    tilesetId: num(getIv(raw, '@tileset_id')),
    note: strVal(getIv(raw, '@note')) || strVal(getIv(raw, '@display_name')),
    bgm: audioOf(getIv(raw, '@bgm')),
    bgs: audioOf(getIv(raw, '@bgs')),
    events: []
  };
  const evs = getIv(raw, '@events');
  const push = (evId, ev) => {
    if (!ev || !ev.__iv) return;
    const pages = getIv(ev, '@pages');
    map.events.push({
      id: num(evId),
      name: strVal(getIv(ev, '@name')),
      x: num(getIv(ev, '@x')),
      y: num(getIv(ev, '@y')),
      note: strVal(getIv(ev, '@note')),
      pages: (pages && Array.isArray(pages.__arr) ? pages.__arr : []).map((p) => {
        const cond = getIv(p, '@condition') || {};
        const g = getIv(p, '@graphic') || {};
        return {
          conditions: {
            switch1Valid: !!getIv(cond, '@switch1_valid'),
            switch1Id: num(getIv(cond, '@switch1_id')),
            switch2Valid: !!getIv(cond, '@switch2_valid'),
            switch2Id: num(getIv(cond, '@switch2_id')),
            variableValid: !!getIv(cond, '@variable_valid'),
            variableId: num(getIv(cond, '@variable_id')),
            variableValue: num(getIv(cond, '@variable_value')),
            selfSwitchValid: !!getIv(cond, '@self_switch_valid'),
            selfSwitchCh: strVal(getIv(cond, '@self_switch_ch')) || 'A',
            itemValid: !!getIv(cond, '@item_valid'),
            itemId: num(getIv(cond, '@item_id')),
            actorValid: !!getIv(cond, '@actor_valid'),
            actorId: num(getIv(cond, '@actor_id'))
          },
          image: {
            characterName: strVal(getIv(g, '@character_name')),
            characterIndex: num(getIv(g, '@character_index')),
            direction: num(getIv(g, '@direction')),
            pattern: num(getIv(g, '@pattern')),
            tileId: num(getIv(g, '@tile_id'))
          },
          moveType: num(getIv(p, '@move_type')),
          moveSpeed: num(getIv(p, '@move_speed')),
          moveFrequency: num(getIv(p, '@move_frequency')),
          through: !!getIv(p, '@through'),
          priorityType: num(getIv(p, '@priority_type')),
          trigger: num(getIv(p, '@trigger')),
          commands: normalizeCommands(decodeCommands(getIv(p, '@list')), engine),
          raw: p
        };
      })
    });
  };

  if (evs && Array.isArray(evs.__hash)) for (const [k, v] of evs.__hash) push(k, v);
  else if (evs && Array.isArray(evs.__arr)) evs.__arr.forEach((v, i) => push(i, v));
  return map;
}

function decodeCommands(list) {
  if (!list || !Array.isArray(list.__arr)) return [];
  return list.__arr.map((c) => ({
    raw: c,
    code: num(getIv(c, '@code')),
    indent: num(getIv(c, '@indent')),
    parameters: (getIv(c, '@parameters').__arr || []).map((p) => {
      if (p && p.__str) return strVal(p);
      if (p && p.__iv) return audioOf(p) || p;
      if (p && p.__arr) return p.__arr.map((x) => (x && x.__str ? strVal(x) : x));
      return p;
    })
  }));
}

function audioOf(o) {
  if (!o || !o.__iv) return null;
  const name = strVal(getIv(o, '@name'));
  if (!name) return null;
  return { name, volume: num(getIv(o, '@volume')), pitch: num(getIv(o, '@pitch')) };
}
