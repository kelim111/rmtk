/* =========================================================================
   引擎识别：看文件夹里有什么，判断这是哪个版本的 RPG Maker 工程。
   返回一个「引擎档案」，后面的解析器都按它来分派。
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { load as marshalLoad, getIv as marshalGetIv } from '../parsers/marshal.js';

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'latin1'); } catch { return ''; }
}

function listDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

/** 在工程里找 data 目录：MV 的 www/data、MZ 的 data、XP/VX 的 Data */
function findDataDir(root) {
  const candidates = [
    ['data', 'json'],                       // MZ
    [path.join('www', 'data'), 'json'],     // MV（带 www）
    ['Data', 'rvdata'],                     // VX / VX Ace
    ['Data', 'rxdata'],                     // XP
    ['data', 'json']                        // MV（把 data 拷到根目录的情况）
  ];
  for (const [rel, kind] of candidates) {
    const dir = path.join(root, rel);
    const files = listDir(dir);
    if (!files.length) continue;
    const hit = files.some((f) => f.toLowerCase().endsWith('.' + kind)) ||
      (kind === 'json' && files.includes('System.json'));
    if (hit) return { dir, kind, rel };
  }
  // 用户可能直接传了 data 文件夹本身
  const files = listDir(root);
  if (files.includes('System.json')) return { dir: root, kind: 'json', rel: '.' };
  if (files.some((f) => /\.rvdata$/i.test(f))) return { dir: root, kind: 'rvdata', rel: '.' };
  if (files.some((f) => /\.rxdata$/i.test(f))) return { dir: root, kind: 'rxdata', rel: '.' };
  return null;
}

function findLcfFiles(root) {
  const hits = {};
  const scan = (dir, depth) => {
    if (depth > 2) return;
    for (const name of listDir(dir)) {
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { scan(full, depth + 1); continue; }
      const lower = name.toLowerCase();
      if (lower.endsWith('.lmu')) hits.lmu = hits.lmu || [];
      if (lower.endsWith('.lmu')) hits.lmu.push(full);
      if (lower === 'rpg_rt.lmt') hits.lmt = full;
      if (lower === 'rpg_rt.ldb') hits.ldb = full;
      if (lower === 'rpg_rt.exe') hits.exe = full;
    }
  };
  scan(root, 0);
  return hits;
}

export function detectEngine(root) {
  const abs = path.resolve(root);
  if (!exists(abs)) throw new Error(`路径不存在：${abs}`);
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error(`请传工程文件夹（现在传的是文件）：${abs}`);

  const data = findDataDir(abs);
  const topFiles = listDir(abs);

  // --- LCF：2000 / 2003 ---
  const lcf = findLcfFiles(abs);
  if (!data && (lcf.lmt || lcf.ldb || (lcf.lmu && lcf.lmu.length))) {
    const ini = readTextSafe(path.join(abs, 'RPG_RT.ini'));
    const is2003 = /2003/i.test(ini) || exists(path.join(abs, 'RPG_RT.exe.manifest'));
    return {
      engine: is2003 ? '2003' : '2000',
      family: 'lcf',
      label: is2003 ? 'RPG Maker 2003' : 'RPG Maker 2000',
      root: abs,
      lcf,
      experimental: true,
      note: '2000/2003 用的是 LCF 二进制格式，本工具做的是「尽力解析」，事件指令映射可能不完整'
    };
  }

  if (!data) {
    throw new Error(
      '没找到可识别的数据目录。请指向工程根目录（里面有 data/Data 文件夹）。\n' +
      '  支持的形态：MZ 的 data/*.json、MV 的 www/data/*.json、VX/VX Ace 的 Data/*.rvdata、XP 的 Data/*.rxdata'
    );
  }

  // --- JSON：MV / MZ ---
  if (data.kind === 'json') {
    const sys = safeJson(path.join(data.dir, 'System.json')) || {};
    const jsFiles = listDir(path.join(abs, 'js'));
    let engine = 'MV';
    if (jsFiles.some((f) => /^rmmz_/i.test(f)) || sys.advanced !== undefined) engine = 'MZ';
    else if (jsFiles.some((f) => /^rpg_/i.test(f))) engine = 'MV';
    return {
      engine,
      family: 'json',
      label: engine === 'MZ' ? 'RPG Maker MZ' : 'RPG Maker MV',
      root: abs,
      dataDir: data.dir,
      dataRel: data.rel,
      experimental: false
    };
  }

  // --- Marshal：XP / VX / VX Ace ---
  const ini = readTextSafe(path.join(abs, 'Game.ini'));
  const dll = topFiles.find((f) => /^RGSS\d+.*\.dll$/i.test(f)) || '';
  const dllFromIni = (ini.match(/Library\s*=\s*([^\r\n]+)/i) || [])[1] || '';
  const lib = (dll || dllFromIni).toUpperCase();
  let engine = data.kind === 'rxdata' ? 'XP' : 'VX';
  if (lib.includes('RGSS3')) engine = 'VXAce';
  else if (lib.includes('RGSS2')) engine = 'VX';
  else if (lib.includes('RGSS1')) engine = 'XP';
  else if (data.kind === 'rvdata') {
    // 没 DLL 就靠数据文件特征判断：Ace 的 System 里有 @version_id = 2
    engine = probeAceOrVx(data.dir);
  }
  const labels = { XP: 'RPG Maker XP', VX: 'RPG Maker VX', VXAce: 'RPG Maker VX Ace' };
  return {
    engine,
    family: 'marshal',
    label: labels[engine] || engine,
    root: abs,
    dataDir: data.dir,
    dataRel: data.rel,
    experimental: engine === 'XP',
    note: engine === 'XP' ? 'XP 的事件指令编号与 VX 不同，已按 XP 的指令表解析' : undefined
  };
}

function probeAceOrVx(dir) {
  try {
    const buf = fs.readFileSync(path.join(dir, 'System.rvdata'));
    const sys = marshalLoad(buf);
    const v = marshalGetIv(sys, '@version_id');
    if (v === 2) return 'VXAce';
    if (v === 1) return 'VX';
  } catch { /* 忽略 */ }
  return 'VX';
}

function safeJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
