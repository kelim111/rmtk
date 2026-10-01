/* =========================================================================
   语言包导出：
     - translation.<lang>.json   「原文 → 译文」字典
     - dialogue.<lang>.csv       带位置信息的对照表（方便校对）
     - RMTK_Translation.js       MV / MZ 的运行时插件（不改数据文件）
     - rmtk_translation.rb       XP / VX / VX Ace 的运行时补丁
     - <lang>.json               插件要读的语言包文件
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { makeMvLanguagePackPlugin, makeRubyLanguagePatch, toCsv } from '../analyzers/dialogue.js';

export function exportLanguagePack(project, { rows, dict, lang = 'zh_CN', outDir = 'out' }) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const write = (name, content) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, content, 'utf8');
    written.push(file);
    return file;
  };

  write(`translation.${lang}.json`, JSON.stringify({ lang, engine: project.engine, entries: dict }, null, 2));
  write(`dialogue.${lang}.csv`, toCsv(rows));

  const isJsonEngine = project.engine === 'MV' || project.engine === 'MZ';
  if (isJsonEngine) {
    write(`RMTK_Translation.js`, makeMvLanguagePackPlugin(dict, lang));
    write(`${lang}.json`, JSON.stringify(dict, null, 2));
  } else if (project.engine !== '2000' && project.engine !== '2003') {
    write(`rmtk_translation.rb`, makeRubyLanguagePatch(dict));
  } else {
    write(`rmtk_translation.txt`, Object.entries(dict).map(([a, b]) => `${a}\t=>\t${b}`).join('\n'));
  }
  write('HOWTO.txt', howTo(project, lang));
  return { outDir, files: written, entries: Object.keys(dict).length };
}

function howTo(project, lang) {
  const e = project.engine;
  const common = `由 rmtk（RPG Maker 工程 AI 辅助解析工具）生成
引擎：${project.label || e}   语言：${lang}
生成时间：${new Date().toISOString()}

`;
  if (e === 'MV' || e === 'MZ') {
    return common + `【怎么用】
方案 A（推荐，不改数据文件）
  1. 把 RMTK_Translation.js 和 ${lang}.json 放进工程的 js/plugins/
  2. 打开工程 → 插件管理器 → 启用 RMTK_Translation（语言参数填 ${lang}）
方案 B（直接把译文烧进数据）
  rmtk translate <工程目录> --apply --translator openai --target ${lang}
  工具会改 data/*.json，并在改之前备份成 *.json.bak
`;
  }
  if (e === '2000' || e === '2003') {
    return common + `【怎么用】
2000/2003 的数据文件是 LCF 二进制，直接回填风险较大，建议：
  1. 用 rmtk_translation.txt 里的对照表，在 RPG Maker 2000 的数据库里手工替换
  2. 或者把对照表交给懂脚本的朋友做批量导入
`;
  }
  return common + `【怎么用】
方案 A（推荐，不改数据文件）
  1. 打开工程 → 脚本编辑器（F11）
  2. 新建一个脚本段，把 rmtk_translation.rb 的内容整段粘进去
  3. 位置放在 Main 之前（或者任意脚本的最下面）—— 它只拦文本，不动别的逻辑
方案 B（直接把译文烧进数据）
  rmtk translate <工程目录> --apply
  工具会用内置的 Ruby Marshal 读写器改写 Data/*.rvdata|.rxdata，
  改之前备份为 *.bak；读完写回是字节级一致的，改动只落在文本上。
`;
}
