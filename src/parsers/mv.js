/* =========================================================================
   RPG Maker MV / MZ 解析器（都是 JSON，最省事）
     data/System.json, MapInfos.json, Map###.json, Actors/Items/... .json
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { kindOf } from './commands.js';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const listDir = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

export function parseJsonProject(meta) {
  const { root, dataDir, engine } = meta;
  const files = listDir(dataDir);
  const read = (name) => {
    const exact = files.find((f) => f.toLowerCase() === name.toLowerCase());
    return exact ? readJson(path.join(dataDir, exact)) : null;
  };

  const sys = read('System.json') || {};
  const mapInfos = read('MapInfos.json') || [];
  const commonEventsRaw = read('CommonEvents.json') || [];
  const db = {
    actors: read('Actors.json') || [],
    classes: read('Classes.json') || [],
    items: read('Items.json') || [],
    weapons: read('Weapons.json') || [],
    armors: read('Armors.json') || [],
    skills: read('Skills.json') || [],
    states: read('States.json') || [],
    enemies: read('Enemies.json') || [],
    troops: read('Troops.json') || [],
    commonEvents: read('CommonEvents.json') || [],
    tilesets: read('Tilesets.json') || []
  };

  const infoById = new Map();
  for (const info of mapInfos) if (info) infoById.set(info.id, info);

  const mapFiles = files
    .map((f) => ({ f, m: /^Map(\d+)\.json$/i.exec(f) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));

  const maps = [];
  for (const { f, m } of mapFiles) {
    const id = Number(m[1]);
    const raw = readJson(path.join(dataDir, f));
    if (!raw) continue;
    maps.push(normalizeMap(id, raw, infoById.get(id), engine, dataDir, path.join(dataDir, f)));
  }

  return {
    engine,
    label: meta.label,
    root,
    dataDir,
    system: {
      title: sys.gameTitle || '',
      versionId: sys.versionId,
      startMapId: sys.startMapId,
      startX: sys.startX,
      startY: sys.startY,
      partyMembers: sys.partyMembers || [],
      currency: sys.currencyUnit || '',
      switches: (sys.switches || []).map((s, i) => ({ id: i, name: String(s ?? '') })),
      variables: (sys.variables || []).map((s, i) => ({ id: i, name: String(s ?? '') })),
      raw: sys
    },
    maps,
    database: db,
    commonEvents: db.commonEvents.map((ce, i) => (ce ? {
      id: ce.id ?? i,
      name: ce.name || '',
      trigger: ce.trigger,
      switchId: ce.switchId,
      commands: normalizeCommands(ce.list || [], engine)
    } : null)).filter(Boolean),
    commonEventsRaw,
    commonEventsFile: files.find((f) => f.toLowerCase() === 'commonevents.json')
      ? path.join(dataDir, files.find((f) => f.toLowerCase() === 'commonevents.json'))
      : null,
    experimental: false
  };
}

function normalizeMap(id, raw, info, engine, dataDir, file) {
  const map = {
    id,
    file,
    raw,
    name: info?.name || raw.name || '',
    width: raw.width || 0,
    height: raw.height || 0,
    tilesetId: raw.tilesetId,
    note: raw.note || '',
    bgm: raw.bgm || null,
    bgs: raw.bgs || null,
    events: []
  };
  const events = raw.events || [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    map.events.push({
      id: ev.id ?? i,
      name: ev.name || '',
      x: ev.x, y: ev.y,
      note: ev.note || '',
      pages: (ev.pages || []).map((p) => ({
        conditions: p.conditions || {},
        image: p.image || {},
        moveType: p.moveType, moveSpeed: p.moveSpeed, moveFrequency: p.moveFrequency,
        through: !!p.through,
        priorityType: p.priorityType,
        trigger: p.trigger,
        commands: normalizeCommands(p.list || [], engine),
        raw: p
      }))
    });
  }
  return map;
}

export function normalizeCommands(list, engine) {
  const out = [];
  for (const c of list || []) {
    if (!c) continue;
    const cmd = {
      code: c.code,
      indent: c.indent || 0,
      params: c.parameters || [],
      kind: kindOf(engine, c.code),
      raw: c.raw || c
    };
    if (cmd.kind === 'text' || cmd.kind === 'textHeader') {
      cmd.text = String(cmd.params[0] ?? '');
      if (cmd.kind === 'textHeader') {
        cmd.faceName = String(cmd.params[0] ?? '');
        cmd.faceIndex = Number(cmd.params[1] ?? 0);
        cmd.speaker = cmd.params.length >= 5 ? String(cmd.params[4] ?? '') : '';
      }
    }
    if (cmd.kind === 'choice') cmd.choices = (cmd.params[0] || []).map(String);
    if (cmd.kind === 'transfer') {
      cmd.designation = Number(cmd.params[0] ?? 0);
      cmd.targetMapId = Number(cmd.params[1] ?? 0);
      cmd.targetX = Number(cmd.params[2] ?? 0);
      cmd.targetY = Number(cmd.params[3] ?? 0);
      cmd.direction = Number(cmd.params[4] ?? 0);
    }
    if (cmd.kind === 'setSwitch') {
      cmd.switchStart = Number(cmd.params[0] ?? 0);
      cmd.switchEnd = Number(cmd.params[1] ?? cmd.params[0] ?? 0);
      cmd.value = cmd.params[2];
    }
    if (cmd.kind === 'setVariable') {
      cmd.variableStart = Number(cmd.params[0] ?? 0);
      cmd.variableEnd = Number(cmd.params[1] ?? cmd.params[0] ?? 0);
      cmd.operation = Number(cmd.params[2] ?? 0);
      cmd.operandType = Number(cmd.params[3] ?? 0);
      cmd.operand = cmd.params[4];
    }
    if (cmd.kind === 'condSwitch') {
      cmd.condType = Number(cmd.params[0] ?? 0);
      cmd.condId = Number(cmd.params[1] ?? 0);
      cmd.condValue = cmd.params[2];
      cmd.condExtra = cmd.params.slice(3);
    }
    if (cmd.kind === 'selfSwitch') {
      cmd.selfSwitchCh = String(cmd.params[0] ?? 'A');
      cmd.value = cmd.params[1];
    }
    if (['bgm', 'bgs', 'se', 'me', 'picture'].includes(cmd.kind)) {
      const audio = cmd.params[0];
      if (audio && typeof audio === 'object') cmd.audio = audio;
      else cmd.audio = { name: String(audio ?? '') };
      if (cmd.kind === 'picture') cmd.audio = { name: String(cmd.params[1] ?? '') };
    }
    if (cmd.kind === 'callCommon') cmd.commonEventId = Number(cmd.params[0] ?? 0);
    if (cmd.kind === 'script' || cmd.kind === 'plugin') cmd.script = String(cmd.params[0] ?? '');
    out.push(cmd);
  }
  return out;
}
