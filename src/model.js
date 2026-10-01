/* =========================================================================
   统一工程模型：把各版本解析出来的东西，整理成同一套结构。
     对话、场所移动、开关/变量引用、素材引用，全在这里算出来，
     后面所有的分析器 / 文档生成器 / 翻译器都只认这一套。
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { detectEngine } from './engines/detect.js';
import { parseJsonProject } from './parsers/mv.js';
import { parseMarshalProject } from './parsers/rvdata.js';
import { parseLcfProject } from './parsers/lcf.js';

/* ------------------------------------------------------------ 素材目录表 */

const ASSET_LAYOUT = {
  MV: {
    char: ['img/characters'], face: ['img/faces'], picture: ['img/pictures'],
    bgm: ['audio/bgm'], bgs: ['audio/bgs'], se: ['audio/se'], me: ['audio/me'],
    imgExt: ['.png'], audioExt: ['.ogg', '.m4a', '.wav', '.mp3']
  },
  MZ: {
    char: ['img/characters'], face: ['img/faces'], picture: ['img/pictures'],
    bgm: ['audio/bgm'], bgs: ['audio/bgs'], se: ['audio/se'], me: ['audio/me'],
    imgExt: ['.png'], audioExt: ['.ogg', '.m4a', '.wav', '.mp3']
  },
  VX: {
    char: ['Graphics/Characters'], face: ['Graphics/Faces'], picture: ['Graphics/Pictures'],
    bgm: ['Audio/BGM'], bgs: ['Audio/BGS'], se: ['Audio/SE'], me: ['Audio/ME'],
    imgExt: ['.png'], audioExt: ['.ogg', '.mid', '.midi', '.mp3', '.wav', '.m4a']
  },
  VXAce: {
    char: ['Graphics/Characters'], face: ['Graphics/Faces'], picture: ['Graphics/Pictures'],
    bgm: ['Audio/BGM'], bgs: ['Audio/BGS'], se: ['Audio/SE'], me: ['Audio/ME'],
    imgExt: ['.png'], audioExt: ['.ogg', '.mid', '.midi', '.mp3', '.wav', '.m4a']
  },
  XP: {
    char: ['Graphics/Characters'], face: ['Graphics/Faces'], picture: ['Graphics/Pictures'],
    bgm: ['Audio/BGM'], bgs: ['Audio/BGS'], se: ['Audio/SE'], me: ['Audio/ME'],
    imgExt: ['.png', '.jpg', '.jpeg'], audioExt: ['.ogg', '.mid', '.midi', '.mp3', '.wav', '.m4a']
  },
  '2000': {
    char: ['Charset'], face: ['FaceSet'], picture: ['Picture'],
    bgm: ['Music'], bgs: ['Music'], se: ['Sound'], me: ['Sound'],
    imgExt: ['.png', '.bmp'], audioExt: ['.wav', '.mid', '.mp3', '.ogg']
  }
};
ASSET_LAYOUT['2003'] = ASSET_LAYOUT['2000'];

function findDirCI(root, rel) {
  let cur = root;
  for (const part of rel.split('/')) {
    let names;
    try { names = fs.readdirSync(cur); } catch { return null; }
    const hit = names.find((n) => n.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  try { return fs.statSync(cur).isDirectory() ? cur : null; } catch { return null; }
}

function listFilesCI(dir) {
  if (!dir) return [];
  try { return fs.readdirSync(dir).map((f) => f.toLowerCase()); } catch { return []; }
}

/* ------------------------------------------------------------ 组装工程 */

export function loadProject(root) {
  const meta = detectEngine(root);
  let project;
  if (meta.family === 'json') project = parseJsonProject(meta);
  else if (meta.family === 'marshal') project = parseMarshalProject(meta);
  else project = parseLcfProject(meta);
  project.meta = meta;
  enrich(project);
  return project;
}

/* -------------------------------------------------- 对话 / 跳转 / 引用收集 */

function walkCommands(commands, fn) {
  for (let i = 0; i < commands.length; i++) fn(commands[i], i);
}

/** 从台词里猜说话人：`静香「……」` / `大雄: xxx` / 一般社团的写法 */
export function guessSpeaker(text) {
  const m = /^\s*([^\s「『『"“:：]{1,8})\s*[「『『"“:：]/.exec(text);
  if (m) return m[1];
  return '';
}

function enrich(project) {
  const dialogues = [];
  const transfers = [];
  const switchSets = new Map();     // id -> [{mapId,eventId,page}]
  const switchReads = new Map();
  const varSets = new Map();
  const varReads = new Map();
  const selfSwitchSets = new Map();
  const selfSwitchReads = new Map();
  const assets = { used: [], missing: [] };
  const usedChars = new Set(), usedFaces = new Set(), usedAudio = new Set(), usedPictures = new Set();
  const callCommon = new Map();
  const scriptCommands = [];

  const bump = (map, id, info) => {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(info);
  };

  const collect = (commands, ctx) => {
    let header = null;
    let choiceDepth = 0;
    walkCommands(commands, (cmd, idx) => {
      switch (cmd.kind) {
        case 'textHeader':
          header = { faceName: cmd.faceName || '', faceIndex: cmd.faceIndex || 0, speaker: cmd.speaker || '' };
          if (header.faceName) usedFaces.add(header.faceName);
          break;
        case 'text': {
          const text = cmd.text ?? '';
          if (!text) break;
          const speaker = header?.speaker || guessSpeaker(text);
          dialogues.push({
            key: `${ctx.mapId}/${ctx.eventId}/${ctx.pageIndex}/${idx}`,
            mapId: ctx.mapId, mapName: ctx.mapName,
            eventId: ctx.eventId, eventName: ctx.eventName,
            pageIndex: ctx.pageIndex, cmdIndex: idx,
            text, speaker,
            faceName: header?.faceName || '', faceIndex: header?.faceIndex ?? 0,
            source: ctx.source
          });
          break;
        }
        case 'choice':
          (cmd.choices || []).forEach((c, ci) => {
            dialogues.push({
              key: `${ctx.mapId}/${ctx.eventId}/${ctx.pageIndex}/${idx}/c${ci}`,
              mapId: ctx.mapId, mapName: ctx.mapName,
              eventId: ctx.eventId, eventName: ctx.eventName,
              pageIndex: ctx.pageIndex, cmdIndex: idx,
              text: c, speaker: '', isChoice: true,
              faceName: '', faceIndex: 0, source: ctx.source
            });
          });
          break;
        case 'transfer':
          transfers.push({
            mapId: ctx.mapId, mapName: ctx.mapName,
            eventId: ctx.eventId, eventName: ctx.eventName,
            pageIndex: ctx.pageIndex, cmdIndex: idx,
            designation: cmd.designation,
            targetMapId: cmd.targetMapId, targetX: cmd.targetX, targetY: cmd.targetY,
            direction: cmd.direction
          });
          break;
        case 'setSwitch': {
          const from = cmd.switchStart || 0, to = cmd.switchEnd || from;
          for (let id = from; id <= to; id++) bump(switchSets, id, ctx);
          break;
        }
        case 'condSwitch':
          if (cmd.condType === 0) bump(switchReads, cmd.condId, ctx);
          else if (cmd.condType === 1) bump(varReads, cmd.condId, ctx);
          else if (cmd.condType === 2) bump(selfSwitchReads, `${ctx.mapId}/${ctx.eventId}/${cmd.condId ?? 'A'}`, ctx);
          break;
        case 'setVariable': {
          const from = cmd.variableStart || 0, to = cmd.variableEnd || from;
          for (let id = from; id <= to; id++) bump(varSets, id, ctx);
          if (cmd.operandType === 1 && typeof cmd.operand === 'number') bump(varReads, cmd.operand, ctx);
          break;
        }
        case 'selfSwitch':
          bump(selfSwitchSets, `${ctx.mapId}/${ctx.eventId}/${cmd.selfSwitchCh}`, ctx);
          break;
        case 'callCommon':
          bump(callCommon, cmd.commonEventId, ctx);
          break;
        case 'se': case 'bgm': case 'bgs': case 'me':
          if (cmd.audio?.name) usedAudio.add(`${cmd.kind}:${cmd.audio.name}`);
          break;
        case 'picture':
          if (cmd.audio?.name) usedPictures.add(cmd.audio.name);
          break;
        case 'script':
          if (cmd.script) {
            scriptCommands.push({ ...ctx, text: cmd.script });
            /* 脚本指令里也常常在改开关/变量（$game_switches[12] = true、
               $gameSwitches.setValue(12, true)……），不算进来的话会误报「只读不写」 */
            for (const m of cmd.script.matchAll(/\$game[_sS]witches(?:\[|\s*\.\s*setValue\(\s*)(\d+)\s*\]?\s*(=|\()/g)) {
              bump(switchSets, Number(m[1]), ctx);
            }
            for (const m of cmd.script.matchAll(/\$game_[vV]ariables(?:\[|\s*\.\s*setValue\(\s*)(\d+)\s*\]?\s*(=|\()/g)) {
              bump(varSets, Number(m[1]), ctx);
            }
            for (const m of cmd.script.matchAll(/\$game_switches\[\s*(\d+)\s*\]/g)) {
              if (!/\$game_switches\[\s*\d+\s*\]\s*=/.test(m[0])) bump(switchReads, Number(m[1]), ctx);
            }
          }
          break;
        default: break;
      }
      if (cmd.kind === 'choice') choiceDepth++;
      if (cmd.kind === 'choiceEnd') choiceDepth = Math.max(0, choiceDepth - 1);
    });
    return { choiceDepth };
  };

  for (const map of project.maps) {
    map.dialogues = [];
    map.transfers = [];
    for (const ev of map.events) {
      if (ev.x == null || ev.y == null) continue;
      ev.pages.forEach((page, pageIndex) => {
        const ctx = {
          mapId: map.id, mapName: map.name,
          eventId: ev.id, eventName: ev.name,
          pageIndex, source: 'map'
        };
        // 事件页自身的出现条件也算「读开关 / 读变量」
        const c = page.conditions || {};
        if (c.switch1Valid) bump(switchReads, c.switch1Id, ctx);
        if (c.switch2Valid) bump(switchReads, c.switch2Id, ctx);
        if (c.variableValid) bump(varReads, c.variableId, ctx);
        if (c.selfSwitchValid) bump(selfSwitchReads, `${map.id}/${ev.id}/${c.selfSwitchCh || 'A'}`, ctx);
        const img = page.image || {};
        if (img.characterName) usedChars.add(img.characterName);
        collect(page.commands, ctx);
      });
    }
    map.dialogues = dialogues.filter((d) => d.mapId === map.id);
    map.transfers = transfers.filter((t) => t.mapId === map.id);
  }

  for (const ce of project.commonEvents || []) {
    if (!ce.commands?.length) continue;
    const ctx = { mapId: 0, mapName: '（公共事件）', eventId: ce.id, eventName: ce.name, pageIndex: 0, source: 'common' };
    collect(ce.commands, ctx);
  }

  project.dialogues = dialogues;
  project.transfers = transfers;
  project.refs = { switchSets, switchReads, varSets, varReads, selfSwitchSets, selfSwitchReads, callCommon };
  project.scriptCommands = scriptCommands;

  /* ---- 素材检查 ---- */
  const layout = ASSET_LAYOUT[project.engine] || ASSET_LAYOUT.VX;
  const dirs = {};
  for (const key of ['char', 'face', 'picture', 'bgm', 'bgs', 'se', 'me']) {
    dirs[key] = layout[key].map((rel) => findDirCI(project.root, rel)).find(Boolean) || null;
  }
  const existsIn = (key, name, exts) => {
    const dir = dirs[key];
    if (!dir) return null;                      // 找不到目录 → 不判断（避免误报）
    const files = listFilesCI(dir);
    for (const ext of exts) {
      if (files.includes((name + ext).toLowerCase())) return true;
    }
    // 有的素材文件名带层级（MV 的 img/pictures/foo/bar.png）
    const base = path.basename(name).toLowerCase();
    for (const ext of exts) if (files.includes(base + ext)) return true;
    return false;
  };
  const push = (ok, kind, name) => {
    const rec = { kind, name };
    assets.used.push(rec);
    if (ok === false) assets.missing.push(rec);
  };
  for (const name of usedChars) push(existsIn('char', name, layout.imgExt), 'character', name);
  for (const name of usedFaces) push(existsIn('face', name, layout.imgExt), 'face', name);
  for (const name of usedPictures) push(existsIn('picture', name, layout.imgExt), 'picture', name);
  for (const key of usedAudio) {
    const [kind, name] = key.split(/:(.+)/);
    push(existsIn(kind, name, layout.audioExt), kind, name);
  }
  assets.dirs = dirs;
  project.assets = assets;

  /* ---- 统计 ---- */
  project.stats = {
    maps: project.maps.length,
    events: project.maps.reduce((n, m) => n + m.events.length, 0),
    pages: project.maps.reduce((n, m) => n + m.events.reduce((k, e) => k + e.pages.length, 0), 0),
    dialogues: dialogues.length,
    textLength: dialogues.reduce((n, d) => n + d.text.length, 0),
    transfers: transfers.length,
    switchesUsed: new Set([...switchSets.keys(), ...switchReads.keys()]).size,
    variablesUsed: new Set([...varSets.keys(), ...varReads.keys()]).size,
    items: (project.database.items || []).filter((x) => x && x.name).length,
    enemies: (project.database.enemies || []).filter((x) => x && x.name).length,
    commonEvents: (project.commonEvents || []).length,
    scriptCommands: scriptCommands.length
  };
  return project;
}

/** 名字表：id → 名字（开关 / 变量） */
export function nameTables(project) {
  const sw = new Map();
  const va = new Map();
  for (const s of project.system.switches || []) sw.set(s.id, s.name);
  for (const v of project.system.variables || []) va.set(v.id, v.name);
  return { switches: sw, variables: va };
}
