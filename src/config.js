/* =========================================================================
   工程配置 .rmtkrc.json
   放在工程根目录（或者用 --config 指定），用来：
     - 关掉某些规则 / 改级别 / 忽略某些位置
     - 放术语表（翻译时自动带上）
     - 指定默认输出目录与目标语言
   例：
   {
     "rules": { "PARALLEL_NO_WAIT": "off", "SWITCH_UNNAMED": "info" },
     "ignore": [ { "code": "MAP_UNREACHABLE", "mapId": 3 } ],
     "glossary": { "村长": "Village Elder" },
     "translate": { "to": "zh_CN", "out": "out" }
   }
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';

export const RULES = {
  INFINITE_LOOP: { level: 'error', title: '死循环（循环里没有跳出循环）' },
  LOOP_MAYBE_INFINITE: { level: 'info', title: '循环可能不会跳出（含自定义指令，无法静态判断）' },
  EMPTY_LOOP: { level: 'warning', title: '空循环' },
  AUTORUN_STUCK: { level: 'error', title: '自动执行事件解除不了（会卡死）' },
  PARALLEL_STUCK: { level: 'warning', title: '并行事件解除不了' },
  AUTORUN_NO_CONDITION: { level: 'info', title: '自动执行事件没有任何条件' },
  PARALLEL_NO_WAIT: { level: 'warning', title: '并行事件里没有「等待」（仅 --strict 时检查）' },
  TELEPORT_NO_MAP: { level: 'error', title: '传送到不存在的地图' },
  TELEPORT_OUT_OF_BOUNDS: { level: 'error', title: '传送到地图外的坐标' },
  TELEPORT_SELF_LOOP: { level: 'error', title: '传送到自己脚下（会无限传送）' },
  TELEPORT_DYNAMIC: { level: 'info', title: '场所移动的目标是变量（静态分析看不到）' },
  MAP_UNREACHABLE: { level: 'warning', title: '地图从起始地图走不到' },
  SWITCH_READ_ONLY: { level: 'warning', title: '开关只读不写' },
  VARIABLE_READ_ONLY: { level: 'warning', title: '变量只读不写' },
  SWITCH_UNNAMED: { level: 'info', title: '开关没有名字' },
  VARIABLE_UNNAMED: { level: 'info', title: '变量没有名字' },
  SELF_SWITCH_NEVER_SET: { level: 'info', title: '自己开关永远打不开' },
  ASSET_MISSING: { level: 'error', title: '素材文件不存在（会崩游戏）' },
  EVENT_OUT_OF_BOUNDS: { level: 'error', title: '事件在地图外面' },
  EVENT_OVERLAP: { level: 'info', title: '同一格叠了两个挡路事件' },
  COMMON_EVENT_UNUSED: { level: 'info', title: '公共事件没人调用' },
  START_MAP_MISSING: { level: 'error', title: '起始地图不存在' }
};

export const DEFAULT_CONFIG = {
  rules: {},
  ignore: [],
  glossary: {},
  translate: { to: 'zh_CN', out: 'out' },
  report: { maxDialogueRows: 400 }
};

export function loadConfig(projectRoot, explicitPath) {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [path.join(projectRoot, '.rmtkrc.json'), path.join(projectRoot, 'rmtk.config.json')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { file, config: mergeConfig(raw) };
    } catch (e) {
      return { file, config: mergeConfig({}), error: `配置文件读不动（${file}）：${e.message}` };
    }
  }
  return { file: null, config: mergeConfig({}) };
}

function mergeConfig(raw) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    rules: { ...DEFAULT_CONFIG.rules, ...(raw.rules || {}) },
    translate: { ...DEFAULT_CONFIG.translate, ...(raw.translate || {}) },
    report: { ...DEFAULT_CONFIG.report, ...(raw.report || {}) },
    glossary: { ...(raw.glossary || {}) },
    ignore: Array.isArray(raw.ignore) ? raw.ignore : []
  };
}

/** 按配置过滤 / 降级问题列表 */
export function applyConfigToIssues(issues, config) {
  const out = [];
  for (const issue of issues) {
    const rule = config.rules[issue.code];
    if (rule === 'off' || rule === false) continue;
    let level = issue.level;
    if (typeof rule === 'string' && ['error', 'warning', 'info'].includes(rule)) level = rule;
    const ignored = config.ignore.some((ig) => {
      if (!ig || typeof ig !== 'object') return false;
      if (ig.code && ig.code !== issue.code) return false;
      if (ig.mapId !== undefined && ig.mapId !== issue.where?.mapId) return false;
      if (ig.eventId !== undefined && ig.eventId !== issue.where?.eventId) return false;
      if (ig.eventName !== undefined && ig.eventName !== issue.where?.eventName) return false;
      return true;
    });
    if (ignored) continue;
    out.push(level === issue.level ? issue : { ...issue, level, levelOverridden: true });
  }
  return out;
}

export function writeDefaultConfig(file) {
  const template = {
    $schema: 'https://raw.githubusercontent.com/USER/rmtk/main/rmtkrc.schema.json',
    rules: {
      SWITCH_UNNAMED: 'info',
      COMMON_EVENT_UNUSED: 'off'
    },
    ignore: [
      { code: 'MAP_UNREACHABLE', mapId: 0, eventName: '（示例：忽略某张没人去的地图）' }
    ],
    glossary: {
      '村长': 'Village Elder',
      '大雄': 'Nobita'
    },
    translate: { to: 'zh_CN', out: 'out' },
    report: { maxDialogueRows: 400 }
  };
  fs.writeFileSync(file, JSON.stringify(template, null, 2) + '\n', 'utf8');
  return file;
}
