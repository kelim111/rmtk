/* =========================================================================
   Bug 检查器：专门找 RPG Maker 工程里最让人头疼的「隐性 bug」
     1. 死循环 / 卡死：Loop 没有 Break、自动执行事件关不掉、同一格反复传送
     2. 跳转错误：传送到不存在的地图 / 越界的坐标 / 走不到的地图
     3. 未定义变量：用了但数据库里没命名、只读不写、自己开关永远打不开
     4. 素材缺失：事件里点名要的文件在工程里根本不存在（游戏走到那儿必崩）
     5. 其它：事件落在图外、同一格叠了两个挡路事件……
   每一条都带 code（稳定标识，方便写测试）、level、以及出事的位置。
   ========================================================================= */
import { nameTables } from '../model.js';

const LEVEL_ORDER = { error: 0, warning: 1, info: 2 };

export function runBugChecks(project, options = {}) {
  const strict = !!options.strict;
  const MAX_PER_CODE = Number.isFinite(options.maxPerCode) ? options.maxPerCode : 50;
  const issues = [];
  const add = (level, code, title, detail, where = {}) => {
    issues.push({ level, code, title, detail, where });
  };

  const { switches: swNames, variables: vaNames } = nameTables(project);
  const mapById = new Map(project.maps.map((m) => [m.id, m]));
  const refs = project.refs;

  /* ------------------------------------------------ 1. 死循环 / 卡死 */
  const scanLoops = (commands, ctx, where) => {
    const open = [];      // 还没结束的循环
    const loops = [];     // 已经扫完的循环（结束的 + 没结束的）
    commands.forEach((cmd, i) => {
      /* 先把已经走出去的循环出栈：
         413 是 RM 的「循环结束」标记；缩进回到循环那一层也说明循环结束了。
         不做这一步的话，循环后面的指令会被误算进循环体。 */
      while (open.length) {
        const top = open[open.length - 1];
        if (cmd.code === 413 && cmd.indent === top.indent) break;
        if (cmd.indent <= top.indent) { loops.push(open.pop()); continue; }
        break;
      }
      if (cmd.kind === 'loop') open.push({ index: i, indent: cmd.indent, custom: false });
      else if (cmd.kind === 'breakLoop') { if (open.length) open[open.length - 1].hasBreak = true; }
      else if (cmd.kind === 'exitEvent') { if (open.length) open[open.length - 1].hasExit = true; }
      // 循环体里出现「这个版本特有的自定义指令」时，我们无法判断它会不会跳出循环
      // 注意：413 是循环自己的结束标记，不算「自定义指令」
      else if (cmd.kind === 'other' && open.length && cmd.code !== 413) open[open.length - 1].custom = true;
      if (cmd.code === 413 && open.length && cmd.indent === open[open.length - 1].indent) loops.push(open.pop());
    });
    loops.push(...open);       // 没写结束标记的，也算一个循环
    /* 循环体本身为空的情况，单独再扫一遍（上一步已经出栈了，这里只关心循环体里有没有东西） */
    commands.forEach((cmd, i) => {
      if (cmd.kind !== 'loop') return;
      let j = i + 1, body = 0;
      while (j < commands.length && !(commands[j].code === 413 && commands[j].indent === cmd.indent)) {
        if (commands[j].kind !== 'comment') body++;
        j++;
      }
      if (body === 0) {
        add('warning', 'EMPTY_LOOP', '空循环', `第 ${i} 条指令的循环体里什么都没有，会立刻空转到卡死。`, { ...where, cmdIndex: i });
      }
    });
    for (const l of loops) {
      if (!l.hasBreak && !l.hasExit) {
        if (l.custom) {
          add('info', 'LOOP_MAYBE_INFINITE', '循环可能不会跳出',
            `第 ${l.index} 条指令开始的「循环」里没有「跳出循环」/「中断事件处理」，但循环体里含自定义指令，` +
            '没法静态判断它是否会跳出 —— 建议进游戏实测这一段。',
            { ...where, cmdIndex: l.index });
        } else {
          add('error', 'INFINITE_LOOP',
            '死循环：循环里没有「跳出循环」',
            `第 ${l.index} 条指令开始的「循环」里既没有「跳出循环」也没有「中断事件处理」，运行到这儿会永远卡住。`,
            { ...where, cmdIndex: l.index });
        }
      }
    }
  };

  for (const map of project.maps) {
    for (const ev of map.events) {
      ev.pages.forEach((page, pi) => {
        const where = {
          mapId: map.id, mapName: map.name,
          eventId: ev.id, eventName: ev.name, pageIndex: pi
        };
        scanLoops(page.commands, null, where);

        /* 自动执行 / 并行事件：条件永远解除不了 → 卡死 */
        const trigger = page.trigger;
        if (trigger === 3 || trigger === 4) {
          const conds = [];
          if (page.conditions?.switch1Valid) conds.push(page.conditions.switch1Id);
          if (page.conditions?.switch2Valid) conds.push(page.conditions.switch2Id);
          const neverOff = conds.filter((id) => !refs.switchSets.has(id));
          if (neverOff.length) {
            // 自动执行（3）会让玩家彻底卡死 → error；并行（4）只是长跑 → warning
            add(trigger === 3 ? 'error' : 'warning', trigger === 3 ? 'AUTORUN_STUCK' : 'PARALLEL_STUCK',
              trigger === 3 ? '自动执行事件解除不了（会卡死）' : '并行事件解除不了',
              `这一页靠开关 ${neverOff.join('、')} 触发，但整个工程里（含脚本指令）没有任何地方写这个开关 —— ` +
              (trigger === 3 ? '自动执行事件会一直重播，玩家直接卡死。' : '这个并行事件会永远跑下去。'),
              where);
          }
          if (trigger === 3 && conds.length === 0) {
            add('info', 'AUTORUN_NO_CONDITION',
              '自动执行事件没有任何条件',
              '没有条件的自动执行事件只在「事件本身会转移/擦除自己」时才安全，建议加一个开关条件。', where);
          }
          if (trigger === 4 && strict) {
            const hasWait = page.commands.some((c) => c.kind === 'wait');
            if (!hasWait) {
              add('warning', 'PARALLEL_NO_WAIT', '并行事件里没有「等待」',
                '并行事件不写等待会每帧执行，容易掉帧或让别的并行事件饿死。', where);
            }
          }
        }

        /* 传到脚下那一格：玩家接触型 = 无限传送 */
        page.commands.forEach((cmd, ci) => {
          if (cmd.kind !== 'transfer') return;
          if (cmd.designation !== 0) return;
          if (trigger === 1 && cmd.targetMapId === map.id && cmd.targetX === ev.x && cmd.targetY === ev.y) {
            add('error', 'TELEPORT_SELF_LOOP', '传送到自己脚下（会无限传送）',
              `这个「玩家接触」事件把玩家传回同一格的 (${ev.x}, ${ev.y})，踩上去就会被反复传送。`,
              { ...where, cmdIndex: ci });
          }
        });
      });
    }
  }

  /* ---------------------------------------------------- 2. 跳转错误 */
  for (const t of project.transfers) {
    const where = {
      mapId: t.mapId, mapName: t.mapName,
      eventId: t.eventId, eventName: t.eventName, pageIndex: t.pageIndex, cmdIndex: t.cmdIndex
    };
    if (t.designation !== 0) {
      add('info', 'TELEPORT_DYNAMIC', '场所移动的目标是变量',
        '这里的地图/坐标是变量指定，静态分析看不出来 —— 运行时记得自己确认一下。', where);
      continue;
    }
    const target = mapById.get(t.targetMapId);
    if (!target) {
      add('error', 'TELEPORT_NO_MAP', '传送到不存在的地图',
        `目标地图 ID ${t.targetMapId} 在工程里找不到（地图文件可能被删了、或者 ID 写错了）。`, where);
      continue;
    }
    if (t.targetX < 0 || t.targetY < 0 || t.targetX >= target.width || t.targetY >= target.height) {
      add('error', 'TELEPORT_OUT_OF_BOUNDS', '传送到地图外的坐标',
        `目标「${target.name}」只有 ${target.width}×${target.height}，但这里要传到 (${t.targetX}, ${t.targetY})。`, where);
    }
  }

  /* 地图连通性：从起始地图能不能走到 */
  const startId = project.system.startMapId || project.maps[0]?.id;
  const visited = new Set();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const t of project.transfers) {
      if (t.designation !== 0) continue;
      if (t.mapId === id && mapById.has(t.targetMapId) && !visited.has(t.targetMapId)) queue.push(t.targetMapId);
    }
  }
  const unreachable = project.maps.filter((m) => !visited.has(m.id));
  if (unreachable.length === 1) {
    const map = unreachable[0];
    add('warning', 'MAP_UNREACHABLE', '这张地图走不到',
      `从起始地图（ID ${startId}）沿着所有场所移动都走不到「${map.name || '未命名'}」(ID ${map.id})。` +
      ' 要么是还没接上，要么是有一处传送写错了。', { mapId: map.id, mapName: map.name });
  } else if (unreachable.length > 1) {
    // 大工程里一堆「示例地图 / 未启用地图」很常见，合成一条，别刷屏
    add('info', 'MAP_UNREACHABLE', `${unreachable.length} 张地图从起始地图走不到`,
      '前几张：' + unreachable.slice(0, 12).map((m) => `${m.id}.${m.name || '未命名'}`).join('、') +
      (unreachable.length > 12 ? ' ……' : '') +
      '。\n（示例地图 / 还没接上的地图会很正常地出现在这里，重点看有没有"本该能走到"的。）', {});
  }

  /* ------------------------------------ 3. 未定义 / 只读不写的开关变量 */
  const describeRef = (list) => {
    const first = list[0] || {};
    return first.mapName ? `${first.mapName} / 事件「${first.eventName}」` : '公共事件';
  };
  for (const [id, uses] of refs.switchReads) {
    if (!refs.switchSets.has(id)) {
      add('warning', 'SWITCH_READ_ONLY', `开关 ${id} 只读不写`,
        `有 ${uses.length} 处把它当条件判断（例：${describeRef(uses)}），但整个工程里没有任何地方设置它 —— ` +
        '这一段剧情/页面永远不会触发。', uses[0] ? { mapId: uses[0].mapId, eventId: uses[0].eventId, pageIndex: uses[0].pageIndex } : {});
    }
    const name = swNames.get(id);
    if (!name) {
      add('info', 'SWITCH_UNNAMED', `开关 ${id} 没有名字`,
        `用到了开关 ${id}，但数据库里这个开关没写名字（例：${describeRef(uses)}）。` +
        ' 命名一下以后维护会轻松很多。', uses[0] ? { mapId: uses[0].mapId, eventId: uses[0].eventId } : {});
    }
  }
  for (const [id, uses] of refs.varReads) {
    if (!refs.varSets.has(id)) {
      add('warning', 'VARIABLE_READ_ONLY', `变量 ${id} 只读不写`,
        `有 ${uses.length} 处读取它（例：${describeRef(uses)}），但没有任何地方赋值 —— 判断结果永远是初始值。`,
        uses[0] ? { mapId: uses[0].mapId, eventId: uses[0].eventId } : {});
    }
    if (!vaNames.get(id)) {
      add('info', 'VARIABLE_UNNAMED', `变量 ${id} 没有名字`,
        `用到了变量 ${id}，但数据库里这个名字是空的。`, uses[0] ? { mapId: uses[0].mapId, eventId: uses[0].eventId } : {});
    }
  }
  for (const [key, uses] of refs.selfSwitchReads) {
    if (!refs.selfSwitchSets.has(key)) {
      add('info', 'SELF_SWITCH_NEVER_SET', '自己开关永远打不开',
        `事件的自开关 ${key} 被当作出现条件，但没有任何指令把它打开 —— 这个页面永远不会出现。`,
        uses[0] ? { mapId: uses[0].mapId, eventId: uses[0].eventId, pageIndex: uses[0].pageIndex } : {});
    }
  }

  /* ---------------------------------------------------- 4. 素材缺失 */
  for (const miss of project.assets.missing) {
    const label = { character: '行走图', face: '头像', picture: '图片', bgm: 'BGM', bgs: 'BGS', se: '音效', me: 'ME' }[miss.kind] || miss.kind;
    add('error', 'ASSET_MISSING', `${label}文件不存在：${miss.name}`,
      `事件/数据库里点名要用「${miss.name}」，但工程素材目录里找不到这个文件 —— 游戏跑到这一步会直接报「找不到文件」崩掉。`,
      {});
  }

  /* --------------------------------------------------------- 5. 其它 */
  for (const map of project.maps) {
    const blocked = new Map();
    for (const ev of map.events) {
      if (ev.x < 0 || ev.y < 0 || ev.x >= map.width || ev.y >= map.height) {
        add('error', 'EVENT_OUT_OF_BOUNDS', '事件在地图外面',
          `事件「${ev.name}」在 (${ev.x}, ${ev.y})，但地图只有 ${map.width}×${map.height} —— 它在游戏里根本不会出现。`,
          { mapId: map.id, mapName: map.name, eventId: ev.id, eventName: ev.name });
      }
      const firstPage = ev.pages[0];
      const blocks = firstPage && !firstPage.through && (firstPage.priorityType ?? 1) === 1 && firstPage.image?.characterName;
      if (blocks) {
        const key = `${ev.x},${ev.y}`;
        if (!blocked.has(key)) blocked.set(key, []);
        blocked.get(key).push(ev.name || `#${ev.id}`);
      }
    }
    for (const [pos, names] of blocked) {
      if (names.length > 1) {
        add('info', 'EVENT_OVERLAP', '同一格叠了两个挡路事件',
          `(${pos}) 上叠了：${names.join('、')} —— 玩家可能撞不过去，或者只能触发其中一个。`,
          { mapId: map.id, mapName: map.name });
      }
    }
  }

  const calledCommon = new Set(refs.callCommon.keys());
  for (const ce of project.commonEvents || []) {
    if (ce.name && !calledCommon.has(ce.id) && ce.trigger !== 0) {
      add('info', 'COMMON_EVENT_UNUSED', `公共事件「${ce.name}」没人调用`,
        `公共事件 ${ce.id} 在工程里没有任何一处调用。`, {});
    }
  }
  if (!mapById.has(startId)) {
    add('error', 'START_MAP_MISSING', '起始地图不存在',
      `数据库里写的起始地图 ID 是 ${startId}，但工程里没有这张地图。`, {});
  }

  issues.sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || a.code.localeCompare(b.code));
  /* 同一类问题刷屏时收一收：每类最多留 MAX_PER_CODE 条，剩下的合成一条汇总 */
  const capped = [];
  const perCode = new Map();
  for (const i of issues) {
    const n = perCode.get(i.code) || 0;
    if (n < MAX_PER_CODE) capped.push(i);
    perCode.set(i.code, n + 1);
  }
  for (const [code, n] of perCode) {
    if (n <= MAX_PER_CODE) continue;
    const sample = issues.find((i) => i.code === code);
    capped.push({
      level: 'info',
      code,
      title: `还有 ${n - MAX_PER_CODE} 处同类问题（${code}）`,
      detail: '为了不让报告刷屏，同类问题只列前 ' + MAX_PER_CODE + ' 条。' +
        (sample ? ' 说明参考：' + sample.detail : ''),
      where: {}
    });
  }
  return {
    issues: capped,
    summary: {
      error: issues.filter((i) => i.level === 'error').length,
      warning: issues.filter((i) => i.level === 'warning').length,
      info: issues.filter((i) => i.level === 'info').length,
      total: issues.length,
      shown: capped.length
    }
  };
}
