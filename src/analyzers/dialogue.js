/* =========================================================================
   对话抽取 / 翻译回填
     - 抽取：把工程里所有对话（含选项）抽成一张表，带稳定的 key 与原文哈希
     - 回填：把译文写回工程
         MV/MZ  → 改 data/*.json
         VX/Ace → 改 Data/*.rvdata（用自带的 Marshal 读写器，字节级安全）
         XP     → 改 Data/*.rxdata
       写之前都会先备份成 *.bak
     - 语言包：导出「原文 → 译文」字典 + 一个运行时补丁脚本（不动数据文件）
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load as marshalLoad, dump as marshalDump, getIv, str as marshalStr } from '../parsers/marshal.js';

export const hashText = (t) => crypto.createHash('sha1').update(t, 'utf8').digest('hex').slice(0, 12);

export function extractDialogues(project) {
  return project.dialogues.map((d) => ({
    key: d.key,
    hash: hashText(d.text),
    mapId: d.mapId,
    mapName: d.mapName,
    eventId: d.eventId,
    eventName: d.eventName,
    pageIndex: d.pageIndex,
    cmdIndex: d.cmdIndex,
    speaker: d.speaker || '',
    faceName: d.faceName || '',
    isChoice: !!d.isChoice,
    text: d.text
  }));
}

const CSV_COLUMNS = ['key', 'hash', 'mapId', 'mapName', 'eventId', 'eventName', 'pageIndex', 'cmdIndex', 'speaker', 'text', 'translation'];

export function toCsv(rows, columns = CSV_COLUMNS) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(','));
  return lines.join('\n');
}

/** 极简 CSV 解析（支持引号转义），够处理我们自己导出的表 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

/** 「原文 → 译文」字典（语言包用；同一句原文只留一份） */
export function buildTextDictionary(project, translatedByKey) {
  const dict = {};
  for (const d of project.dialogues) {
    const translated = translatedByKey[d.key];
    if (!translated || translated === d.text) continue;
    if (!(d.text in dict)) dict[d.text] = translated;
  }
  return dict;
}

/* --------------------------------------------------------------- 回填 */

function backupIfNeeded(file) {
  const bak = file + '.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

function setCommandText(engine, cmd, text, choiceIndex) {
  if (engine === 'MV' || engine === 'MZ') {
    const raw = cmd.raw;
    if (!raw || !Array.isArray(raw.parameters)) return false;
    if (choiceIndex !== undefined) {
      if (!Array.isArray(raw.parameters[0])) return false;
      raw.parameters[0][choiceIndex] = text;
    } else {
      raw.parameters[0] = text;
    }
    return true;
  }
  // Marshal（XP / VX / VX Ace）
  const raw = cmd.raw;
  if (!raw || !raw.__iv) return false;
  const params = getIv(raw, '@parameters');
  if (!params || !Array.isArray(params.__arr) || !params.__arr.length) return false;
  if (choiceIndex !== undefined) {
    const list = params.__arr[0];
    if (!list || !Array.isArray(list.__arr)) return false;
    list.__arr[choiceIndex] = marshalStr(text);
  } else {
    params.__arr[0] = marshalStr(text);
  }
  return true;
}

/**
 * 把译文写回工程（会先备份原文件）。
 * @param {object} project loadProject 的结果
 * @param {Record<string,string>} translatedByKey key → 译文
 * @param {{dryRun?:boolean}} opts dryRun=true 只统计不动文件
 */
export function applyTranslations(project, translatedByKey, opts = {}) {
  const engine = project.engine;
  const jsonLike = engine === 'MV' || engine === 'MZ';
  const fileCounts = new Map();
  let applied = 0, failed = 0;

  const touch = (file, n) => fileCounts.set(file, (fileCounts.get(file) || 0) + n);

  const handle = (key, cmd, choiceIndex, file) => {
    const text = translatedByKey[key];
    if (!text) return;
    if (setCommandText(engine, cmd, text, choiceIndex)) { applied++; touch(file, 1); }
    else failed++;
  };

  if (jsonLike) {
    for (const map of project.maps) {
      for (const ev of map.events) {
        ev.pages.forEach((page, pageIndex) => {
          page.commands.forEach((cmd, cmdIndex) => {
            const base = `${map.id}/${ev.id}/${pageIndex}/${cmdIndex}`;
            if (cmd.kind === 'text') handle(base, cmd, undefined, map.file);
            else if (cmd.kind === 'choice') {
              (cmd.choices || []).forEach((_, ci) => handle(`${base}/c${ci}`, cmd, ci, map.file));
            }
          });
        });
      }
    }
    // 公共事件
    const ceFile = project.commonEventsFile;
    if (ceFile) {
      for (const ce of project.commonEvents || []) {
        ce.commands.forEach((cmd, cmdIndex) => {
          if (cmd.kind !== 'text') return;
          handle(`0/${ce.id}/0/${cmdIndex}`, cmd, undefined, ceFile);
        });
      }
    }
    if (!opts.dryRun) {
      for (const [file, n] of fileCounts) {
        if (!file || !fs.existsSync(file)) continue;
        backupIfNeeded(file);
        const root = jsonRootFor(project, file);
        if (!root) continue;
        fs.writeFileSync(file, JSON.stringify(root), 'utf8');
      }
    }
  } else {
    for (const map of project.maps) {
      for (const ev of map.events) {
        ev.pages.forEach((page, pageIndex) => {
          page.commands.forEach((cmd, cmdIndex) => {
            if (cmd.kind !== 'text') return;
            handle(`${map.id}/${ev.id}/${pageIndex}/${cmdIndex}`, cmd, undefined, map.file);
          });
        });
      }
    }
    if (!opts.dryRun) {
      for (const [file, n] of fileCounts) {
        if (!file || !fs.existsSync(file)) continue;
        backupIfNeeded(file);
        const doc = marshalLoad(fs.readFileSync(file));
        // 直接把改过的 raw 节点写回去：重新加载后用同一批引用定位
        fs.writeFileSync(file, marshalDump(mergeBack(doc, project, file)));
      }
    }
  }

  return {
    engine,
    applied,
    failed,
    files: [...fileCounts.entries()].filter(([f]) => f).map(([file, count]) => ({ file, count })),
    note: jsonLike
      ? '已写回 data/*.json（原文件备份为 *.json.bak）'
      : '已写回 Data/*.rvdata|.rxdata（原文件备份为 *.bak），用自带的 Marshal 读写器，读写字节级一致'
  };
}

/** MV/MZ：模型里的 raw 就是文件内容，直接拿它序列化 */
function jsonRootFor(project, file) {
  const map = project.maps.find((m) => m.file === file);
  if (map && map.raw) return map.raw;
  if (/CommonEvents\.json$/i.test(file)) return project.commonEventsRaw || null;
  return null;
}

/**
 * Marshal：模型里保留的是「原始节点引用」，但写回前我们刚重新读了一遍文件，
 * 所以这里把改动后的文本再应用到新读出来的文档上（按 map/event/page/cmd 索引定位）。
 */
function mergeBack(doc, project, file) {
  const map = project.maps.find((m) => m.file === file);
  if (!map) return doc;
  const events = getIv(doc, '@events');
  const hash = events && events.__hash ? events.__hash : null;
  if (!hash) return doc;
  const byId = new Map(hash.map(([k, v]) => [Number(k), v]));
  for (const ev of map.events) {
    const target = byId.get(ev.id);
    if (!target) continue;
    const pages = getIv(target, '@pages');
    if (!pages || !pages.__arr) continue;
    ev.pages.forEach((page, pageIndex) => {
      const p = pages.__arr[pageIndex];
      if (!p) return;
      const list = getIv(p, '@list');
      if (!list || !list.__arr) return;
      page.commands.forEach((cmd, cmdIndex) => {
        const node = list.__arr[cmdIndex];
        if (!node) return;
        const srcParams = getIv(cmd.raw, '@parameters');
        const dstParams = getIv(node, '@parameters');
        if (!srcParams || !dstParams || !dstParams.__arr || !srcParams.__arr) return;
        if (srcParams.__arr[0] !== undefined) dstParams.__arr[0] = srcParams.__arr[0];
      });
    });
  }
  return doc;
}

/* ------------------------------------------------------- 运行时补丁脚本 */

export function makeMvLanguagePackPlugin(dict, langName = 'zh_CN') {
  const body = JSON.stringify(dict, null, 2);
  return `//=============================================================================
// RMTK_Translation.js — 由 RPG Maker 工程解析工具 rmtk 生成
// 语言包：${langName}
// 用法：把本文件和 ${langName}.json 放进 js/plugins/，在插件管理器里启用。
// 原理只拦截「文章 / 选项」的文本，不改动工程数据文件。
//=============================================================================
/*:
 * @target MV MZ
 * @plugindesc 运行时语言包（原文 → 译文）
 * @author rmtk
 * @param language
 * @text 语言
 * @desc 语言包文件名（不含 .json）
 * @default ${langName}
 */
(() => {
  const pluginName = 'RMTK_Translation';
  const params = PluginManager.parameters(pluginName);
  const lang = params['language'] || '${langName}';
  const DICT = ${body};
  const T = (s) => (typeof s === 'string' && DICT[s] !== undefined ? DICT[s] : s);

  const _Game_Message_add = Game_Message.prototype.add;
  Game_Message.prototype.add = function (text) { return _Game_Message_add.call(this, T(text)); };

  const _Window_ChoiceList_commandName = Window_ChoiceList.prototype.commandName;
  Window_ChoiceList.prototype.commandName = function (index) {
    return T(_Window_ChoiceList_commandName.call(this, index));
  };
})();
`;
}

export function makeRubyLanguagePatch(dict) {
  const rubyEsc = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  const lines = [];
  lines.push('#==============================================================================');
  lines.push('# ★ RMTK 语言包（由 rmtk 生成）');
  lines.push('#   放到工程里当脚本插入（在 Main 之前），或直接粘贴到任意脚本段的最下面。');
  lines.push('#   原理：拦截「文章」与「选项」的文字，按字典替换，不改动数据文件。');
  lines.push('#==============================================================================');
  lines.push('module RMTK_TRANSLATION');
  lines.push('  DICT = {');
  for (const [from, to] of Object.entries(dict)) {
    lines.push(`    ${rubyEsc(from)} => ${rubyEsc(to)},`);
  }
  lines.push('  }');
  lines.push('  def self.t(s)');
  lines.push('    return s if s == nil');
  lines.push('    DICT[s] || s');
  lines.push('  end');
  lines.push('end');
  lines.push('');
  lines.push('class Game_Interpreter');
  lines.push('  # 文章：把 401 / XP 的 101 的文字换掉');
  lines.push('  alias __rmtk_command_101 command_101 if method_defined?(:command_101)');
  lines.push('  alias __rmtk_command_401 command_401 if method_defined?(:command_401)');
  lines.push('  def command_401');
  lines.push('    if @params[0].is_a?(String)');
  lines.push('      @params[0] = RMTK_TRANSLATION.t(@params[0])');
  lines.push('    end');
  lines.push('    __rmtk_command_401');
  lines.push('  end');
  lines.push('  def command_101');
  lines.push('    if @params[0].is_a?(String) && @params.size == 1');
  lines.push('      @params[0] = RMTK_TRANSLATION.t(@params[0])');
  lines.push('    end');
  lines.push('    __rmtk_command_101');
  lines.push('  end');
  lines.push('  # 选项');
  lines.push('  alias __rmtk_command_102 command_102 if method_defined?(:command_102)');
  lines.push('  def command_102');
  lines.push('    if @params[0].is_a?(Array)');
  lines.push('      @params[0] = @params[0].map { |c| RMTK_TRANSLATION.t(c) }');
  lines.push('    end');
  lines.push('    __rmtk_command_102');
  lines.push('  end');
  lines.push('end');
  lines.push('');
  return lines.join('\n');
}
