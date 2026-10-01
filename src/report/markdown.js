/* =========================================================================
   一键生成项目文档（Markdown）
     世界观 / 地图一览 / 地图跳转图 / NPC 列表 / 任务树 /
     数据库摘要 / 素材清单 / Bug 报告
   里面所有内容都是从工程数据里推出来的，不需要作者写任何注释。
   ========================================================================= */
import { runBugChecks } from '../analyzers/bugs.js';
import { buildGraph, graphToMermaid, questToMermaid } from '../analyzers/graph.js';
import { nameTables } from '../model.js';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const clip = (s, n = 40) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export function renderMarkdownReport(project, { maxDialogueRows = 400 } = {}) {
  const bugs = runBugChecks(project);
  const graph = buildGraph(project);
  const { switches: swNames, variables: vaNames } = nameTables(project);
  const L = [];
  const stats = project.stats;

  L.push(`# ${project.system.title || 'RPG Maker 工程'} · 工程解析报告`);
  L.push('');
  L.push(`> 由 **rmtk** 自动生成 · 引擎：**${project.label || project.engine}** · 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  if (project.experimental) L.push('>');
  if (project.experimental) L.push(`> ⚠ ${project.description || '这个版本解析是「尽力而为」，事件指令可能不完整。'}`);
  L.push('');
  L.push('## 1. 概览');
  L.push('');
  L.push('| 指标 | 数量 |');
  L.push('| --- | --- |');
  L.push(`| 地图 | ${stats.maps} |`);
  L.push(`| 事件 | ${stats.events} |`);
  L.push(`| 事件页 | ${stats.pages} |`);
  L.push(`| 对话文本 | ${stats.dialogues} 条 / ${stats.textLength} 字 |`);
  L.push(`| 场所移动 | ${stats.transfers} 处 |`);
  L.push(`| 用到的开关 | ${stats.switchesUsed} 个 |`);
  L.push(`| 用到的变量 | ${stats.variablesUsed} 个 |`);
  L.push(`| 道具 / 敌人 | ${stats.items} / ${stats.enemies} |`);
  L.push(`| 公共事件 | ${stats.commonEvents} |`);
  L.push(`| 脚本指令 | ${stats.scriptCommands} |`);
  L.push('');

  /* ---------------------------------------------------------- 世界观 */
  L.push('## 2. 世界观速写（自动归纳）');
  L.push('');
  const mapNames = project.maps.map((m) => m.name).filter(Boolean);
  const speakerCounts = new Map();
  for (const d of project.dialogues) {
    const who = d.speaker || d.eventName;
    if (!who) continue;
    speakerCounts.set(who, (speakerCounts.get(who) || 0) + 1);
  }
  const topSpeakers = [...speakerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const enemyNames = (project.database.enemies || []).filter((e) => e && e.name).map((e) => e.name);
  const itemNames = (project.database.items || []).filter((i) => i && i.name).map((i) => i.name);
  L.push(`- **故事舞台**：${mapNames.slice(0, 12).join('、') || '（没写地图名）'}${mapNames.length > 12 ? ' ……' : ''}`);
  L.push(`- **出场角色**（按台词量排）：${topSpeakers.map(([n, c]) => `${n}(${c})`).join('、') || '（没检测到说话人）'}`);
  if (enemyNames.length) L.push(`- **敌人**：${enemyNames.slice(0, 16).join('、')}${enemyNames.length > 16 ? ' ……' : ''}`);
  if (itemNames.length) L.push(`- **道具**：${itemNames.slice(0, 16).join('、')}${itemNames.length > 16 ? ' ……' : ''}`);
  L.push('');
  L.push('<details><summary>开局几句台词（用来感受语气）</summary>');
  L.push('');
  for (const d of project.dialogues.slice(0, 12)) {
    L.push(`- \`${esc(d.mapName)} / ${esc(d.eventName || '事件' + d.eventId)}\`　${esc(clip(d.text, 60))}`);
  }
  L.push('');
  L.push('</details>');
  L.push('');

  /* --------------------------------------------------------- 地图一览 */
  L.push('## 3. 地图一览');
  L.push('');
  L.push('| ID | 名称 | 尺寸 | 事件 | 对话 | 能走到 | 备注 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const n of graph.mapGraph.nodes) {
    const note = n.id === graph.mapGraph.startId ? '起始地图' : (n.reachable ? '' : '**走不到**');
    L.push(`| ${n.id} | ${esc(n.name)} | ${n.width}×${n.height} | ${n.events} | ${n.dialogues} | ${n.reachable ? '✅' : '❌'} | ${note} |`);
  }
  L.push('');

  L.push('### 3.1 地图跳转图');
  L.push('');
  L.push('```mermaid');
  L.push(graphToMermaid(graph));
  L.push('```');
  L.push('');

  /* ----------------------------------------------------------- NPC */
  L.push('## 4. NPC / 事件列表（带对话的）');
  L.push('');
  L.push('| 地图 | 事件名 | 位置 | 图 | 触发 | 台词数 | 第一句 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  const triggerName = { 0: '决定键', 1: '玩家接触', 2: '事件接触', 3: '自动执行', 4: '并行' };
  let npcCount = 0;
  for (const map of project.maps) {
    for (const ev of map.events) {
      const dlg = map.dialogues.filter((d) => d.eventId === ev.id);
      const img = ev.pages[0]?.image?.characterName || '';
      const hasGraphic = !!img;
      if (!dlg.length && !hasGraphic) continue;
      npcCount++;
      L.push(`| ${esc(map.name || map.id)} | ${esc(ev.name || '事件' + ev.id)} | (${ev.x},${ev.y}) | ${esc(img || '—')} | ${triggerName[ev.pages[0]?.trigger] || '—'} | ${dlg.length} | ${esc(clip(dlg[0]?.text || '', 30))} |`);
    }
  }
  if (!npcCount) L.push('| — | — | — | — | — | — | — |');
  L.push('');

  /* -------------------------------------------------------- 任务树 */
  L.push('## 5. 任务树 / 剧情关卡点');
  L.push('');
  L.push('> 判定方式：一个开关**在某处被打开**、又**在别处被当作条件**，它就是一个剧情关卡点。');
  L.push('> 边 A → B 表示「需要 A 的页面里打开了 B」，也就是 A 之后才轮到 B。');
  L.push('');
  if (graph.quest.nodes.length) {
    L.push('```mermaid');
    L.push(questToMermaid(graph));
    L.push('```');
    L.push('');
    L.push('| 开关 | 名称 | 打开它的地方（前 3） | 依赖它的地方（前 3） | 我之后是 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const n of graph.quest.nodes) {
      const setAt = n.setAt.slice(0, 3).map((x) => `${x.mapName}/${x.eventName || '事件' + x.eventId}`).join('<br>') || '—';
      const reqAt = n.requiredAt.slice(0, 3).map((x) => `${x.mapName}/${x.eventName || '事件' + x.eventId}`).join('<br>') || '—';
      const next = n.next.map((id) => `${swNames.get(id) || id}`).join('、') || '—';
      L.push(`| ${n.id} | ${esc(n.name)} | ${esc(setAt).replace(/&lt;br&gt;/g, '<br>')} | ${esc(reqAt).replace(/&lt;br&gt;/g, '<br>')} | ${esc(next)} |`);
    }
    L.push('');
    L.push('**推进顺序（自动分层）**');
    L.push('');
    graph.quest.layers.forEach((layer, i) => {
      L.push(`${i + 1}. ${layer.map((id) => `\`${swNames.get(id) || '开关' + id}\``).join(' → ')}`);
    });
  } else {
    L.push('（没有检测到符合条件的剧情开关 —— 也可能是这个工程还没做剧情）');
  }
  L.push('');

  /* --------------------------------------------------------- 数据库 */
  L.push('## 6. 数据库摘要');
  L.push('');
  const dbTable = (title, rows, extra) => {
    const list = (rows || []).filter((r) => r && r.name);
    if (!list.length) return;
    L.push(`### ${title}（${list.length}）`);
    L.push('');
    L.push('| ID | 名称 | ' + (extra ? extra.label + ' |' : ''));
    L.push('| --- | --- |' + (extra ? ' --- |' : ''));
    for (const r of list.slice(0, 200)) {
      L.push(`| ${r.id} | ${esc(r.name)} |` + (extra ? ` ${esc(extra.get(r))} |` : ''));
    }
    L.push('');
  };
  dbTable('角色', project.database.actors);
  dbTable('职业', project.database.classes);
  dbTable('道具', project.database.items, { label: '说明', get: (r) => clip(r.description, 30) });
  dbTable('武器', project.database.weapons, { label: '攻击', get: (r) => r.atk ?? '' });
  dbTable('防具', project.database.armors, { label: '说明', get: (r) => clip(r.description, 30) });
  dbTable('敌人', project.database.enemies);
  dbTable('技能', project.database.skills, { label: '说明', get: (r) => clip(r.description, 30) });

  /* ----------------------------------------------------------- 开关 */
  L.push('## 7. 开关 / 变量使用情况');
  L.push('');
  const swAll = new Set([...project.refs.switchSets.keys(), ...project.refs.switchReads.keys()]);
  if (swAll.size) {
    L.push('| ID | 名称 | 写 | 读 | 备注 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const id of [...swAll].sort((a, b) => a - b)) {
      const w = project.refs.switchSets.get(id)?.length || 0;
      const r = project.refs.switchReads.get(id)?.length || 0;
      const note = !swNames.get(id) ? '没命名' : (!w ? '**只读不写**' : (!r ? '只写不读' : ''));
      L.push(`| ${id} | ${esc(swNames.get(id) || '')} | ${w} | ${r} | ${note} |`);
    }
    L.push('');
  } else {
    L.push('（没有用到开关）');
    L.push('');
  }
  const vaAll = new Set([...project.refs.varSets.keys(), ...project.refs.varReads.keys()]);
  if (vaAll.size) {
    L.push('| 变量 | 名称 | 写 | 读 | 备注 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const id of [...vaAll].sort((a, b) => a - b)) {
      const w = project.refs.varSets.get(id)?.length || 0;
      const r = project.refs.varReads.get(id)?.length || 0;
      L.push(`| ${id} | ${esc(vaNames.get(id) || '')} | ${w} | ${r} | ${!vaNames.get(id) ? '没命名' : (!w ? '**只读不写**' : '')} |`);
    }
    L.push('');
  }

  /* ----------------------------------------------------------- 素材 */
  L.push('## 8. 素材引用');
  L.push('');
  L.push(`- 事件/数据库里引用到的素材：**${project.assets.used.length}** 项`);
  L.push(`- 其中**找不到文件**（会导致游戏崩溃）：**${project.assets.missing.length}** 项`);
  if (project.assets.missing.length) {
    L.push('');
    L.push('| 类型 | 文件 |');
    L.push('| --- | --- |');
    for (const m of project.assets.missing) L.push(`| ${m.kind} | ${esc(m.name)} |`);
  }
  L.push('');

  /* ------------------------------------------------------------ Bug */
  L.push('## 9. 隐性 Bug 报告');
  L.push('');
  L.push(`**error ${bugs.summary.error} · warning ${bugs.summary.warning} · info ${bugs.summary.info}**`);
  L.push('');
  const levelName = { error: '🔴 错误', warning: '🟡 警告', info: '🔵 提示' };
  for (const level of ['error', 'warning', 'info']) {
    const list = bugs.issues.filter((i) => i.level === level);
    if (!list.length) continue;
    L.push(`### ${levelName[level]}（${list.length}）`);
    L.push('');
    L.push('| 代码 | 位置 | 问题 | 说明 |');
    L.push('| --- | --- | --- | --- |');
    for (const i of list.slice(0, 200)) {
      const w = i.where || {};
      const pos = [
        w.mapName ? `地图「${w.mapName}」` : (w.mapId ? `地图${w.mapId}` : ''),
        w.eventName ? `事件「${w.eventName}」` : (w.eventId ? `事件${w.eventId}` : ''),
        w.pageIndex !== undefined ? `第${w.pageIndex + 1}页` : ''
      ].filter(Boolean).join(' / ') || '全局';
      L.push(`| \`${i.code}\` | ${esc(pos)} | ${esc(i.title)} | ${esc(clip(i.detail, 120))} |`);
    }
    L.push('');
  }
  if (!bugs.issues.length) {
    L.push('没有发现问题 🎉');
    L.push('');
  }

  /* ------------------------------------------------------- 对话全文 */
  L.push('## 10. 对话全文（前 %d 条）'.replace('%d', Math.min(maxDialogueRows, project.dialogues.length)));
  L.push('');
  L.push('| 地图 | 事件 | 说话人 | 文本 |');
  L.push('| --- | --- | --- | --- |');
  for (const d of project.dialogues.slice(0, maxDialogueRows)) {
    L.push(`| ${esc(d.mapName || d.mapId)} | ${esc(d.eventName || '事件' + d.eventId)} | ${esc(d.speaker || '')} | ${esc(clip(d.text, 80))} |`);
  }
  L.push('');
  if (project.dialogues.length > maxDialogueRows) {
    L.push(`（还有 ${project.dialogues.length - maxDialogueRows} 条，用 \`rmtk extract\` 导出完整 CSV）`);
    L.push('');
  }
  return L.join('\n');
}
