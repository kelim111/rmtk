/* =========================================================================
   地图跳转图 + 任务树
     地图图：节点=地图，边=场所移动（带次数），起点=数据库里的起始地图。
     任务树：把「剧情开关」当作进度节点 ——
       某处会打开、且在别处被当作事件页出现条件 / 条件分歧的开关 = 一个剧情关卡点。
       边 = 「在需要 A 的页面里打开了 B」 ⇒ A 之后才轮到 B。
     这样即使工程里没有任何注释，也能推出一张剧情流程图。
   ========================================================================= */
import { nameTables } from '../model.js';

export function buildGraph(project) {
  const { switches: swNames, variables: vaNames } = nameTables(project);
  const mapById = new Map(project.maps.map((m) => [m.id, m]));
  const startId = project.system.startMapId || project.maps[0]?.id;

  /* ------------------------------------------------------------ 地图图 */
  const edges = new Map();     // "from->to" -> {from,to,count,examples:[]}
  for (const t of project.transfers) {
    if (t.designation !== 0) continue;
    if (!mapById.has(t.targetMapId)) continue;
    const key = `${t.mapId}->${t.targetMapId}`;
    if (!edges.has(key)) edges.set(key, { from: t.mapId, to: t.targetMapId, count: 0, examples: [] });
    const e = edges.get(key);
    e.count++;
    if (e.examples.length < 3) {
      e.examples.push(`${t.mapName}／「${t.eventName || '事件' + t.eventId}」(${t.targetX},${t.targetY})`);
    }
  }
  const reachable = new Set();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of edges.values()) {
      if (e.from === id && !reachable.has(e.to)) queue.push(e.to);
    }
  }
  const inDegree = new Map();
  for (const e of edges.values()) inDegree.set(e.to, (inDegree.get(e.to) || 0) + e.count);

  const mapGraph = {
    startId,
    nodes: project.maps.map((m) => ({
      id: m.id, name: m.name || `地图${m.id}`,
      events: m.events.length, dialogues: m.dialogues.length,
      width: m.width, height: m.height,
      reachable: reachable.has(m.id),
      inDegree: inDegree.get(m.id) || 0
    })),
    edges: [...edges.values()].sort((a, b) => b.count - a.count),
    deadEnds: project.maps.filter((m) => !edges.has(`${m.id}->`) && m.id !== startId).map((m) => m.id)
  };

  /* ------------------------------------------------------------ 任务树 */
  const checkpointIds = new Set();
  for (const id of project.refs.switchSets.keys()) {
    if (project.refs.switchReads.has(id)) checkpointIds.add(id);
  }
  const nodes = new Map();
  for (const id of checkpointIds) {
    nodes.set(id, {
      id, name: swNames.get(id) || `开关 ${id}`,
      setAt: [], requiredAt: [], next: new Set(), after: new Set(), maps: new Set()
    });
  }
  const requiresOf = (page) => {
    const c = page.conditions || {};
    const out = [];
    if (c.switch1Valid) out.push(c.switch1Id);
    if (c.switch2Valid) out.push(c.switch2Id);
    return out.filter((x) => checkpointIds.has(x));
  };
  const setsOf = (commands) => {
    const out = new Set();
    for (const cmd of commands) {
      if (cmd.kind === 'setSwitch') {
        const from = cmd.switchStart || 0, to = cmd.switchEnd || from;
        for (let id = from; id <= to; id++) if (checkpointIds.has(id)) out.add(id);
      }
      if (cmd.kind === 'condSwitch' && cmd.condType === 0 && checkpointIds.has(cmd.condId)) {
        // 条件分歧里打开开关也算，但需要递归看分支体 —— 这里先做一层
      }
    }
    return out;
  };
  for (const map of project.maps) {
    for (const ev of map.events) {
      ev.pages.forEach((page) => {
        const need = requiresOf(page);
        const gives = setsOf(page.commands);
        for (const g of gives) {
          const n = nodes.get(g);
          if (!n) continue;
          n.maps.add(map.id);
          n.setAt.push({ mapId: map.id, mapName: map.name, eventId: ev.id, eventName: ev.name });
          for (const needId of need) {
            if (needId === g) continue;
            n.after.add(needId);
            nodes.get(needId)?.next.add(g);
          }
        }
      });
    }
  }
  for (const [id, n] of nodes) {
    for (const needId of project.refs.switchReads.get(id) || []) {
      n.requiredAt.push({
        mapId: needId.mapId, mapName: needId.mapName,
        eventId: needId.eventId, eventName: needId.eventName
      });
    }
  }
  const questNodes = [...nodes.values()].map((n) => ({
    id: n.id,
    name: n.name,
    maps: [...n.maps],
    setCount: n.setAt.length,
    requiredCount: n.requiredAt.length,
    after: [...n.after],
    next: [...n.next],
    setAt: n.setAt.slice(0, 5),
    requiredAt: n.requiredAt.slice(0, 5)
  })).sort((a, b) => a.id - b.id);

  /* 拓扑分层：能算出剧情的大致先后顺序 */
  const layers = [];
  const remaining = new Map(questNodes.map((n) => [n.id, new Set(n.after)]));
  const placed = new Set();
  while (remaining.size) {
    const layer = [];
    for (const [id, deps] of remaining) {
      if ([...deps].every((d) => !remaining.has(d) || placed.has(d))) layer.push(id);
    }
    if (!layer.length) {                       // 有环（剧情回环也很正常）
      for (const id of remaining.keys()) layer.push(id);
    }
    for (const id of layer) { remaining.delete(id); placed.add(id); }
    layers.push(layer.sort((a, b) => a - b));
  }

  return {
    mapGraph,
    quest: { nodes: questNodes, layers },
    variables: [...project.refs.varSets.keys()].map((id) => ({
      id, name: vaNames.get(id) || `变量 ${id}`,
      written: project.refs.varSets.get(id).length,
      read: (project.refs.varReads.get(id) || []).length
    }))
  };
}

/** 生成 Mermaid 流程图文本，贴到 GitHub / Markdown 里就能看 */
export function graphToMermaid(graph, { maxEdges = 60 } = {}) {
  const lines = ['flowchart TD'];
  const idOf = (n) => `M${n.id}`;
  for (const n of graph.mapGraph.nodes) {
    const label = `${n.id}. ${n.name.replace(/["\n]/g, ' ')}`;
    lines.push(`  ${idOf(n)}["${label}"]`);
    if (!n.reachable) lines.push(`  style ${idOf(n)} fill:#ffe0e0,stroke:#c00`);
    if (n.id === graph.mapGraph.startId) lines.push(`  style ${idOf(n)} fill:#e0ffe0,stroke:#080`);
  }
  for (const e of graph.mapGraph.edges.slice(0, maxEdges)) {
    const label = e.count > 1 ? `|${e.count}|` : '';
    lines.push(`  ${idOf({ id: e.from })} -->${label} ${idOf({ id: e.to })}`);
  }
  return lines.join('\n');
}

export function questToMermaid(graph) {
  const lines = ['flowchart LR'];
  for (const n of graph.quest.nodes) {
    const label = `${n.name}`.replace(/["\n]/g, ' ');
    lines.push(`  S${n.id}["${label}"]`);
  }
  for (const n of graph.quest.nodes) {
    for (const next of n.next) lines.push(`  S${n.id} --> S${next}`);
  }
  return lines.join('\n');
}
