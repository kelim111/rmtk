/* =========================================================================
   守着工程：数据文件一改动，就重新体检一遍（做游戏的时候挂在旁边很方便）
   只监听数据目录，不会把临时文件/备份也算成改动。
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { loadProject } from './model.js';
import { runBugChecks } from './analyzers/bugs.js';
import { applyConfigToIssues } from './config.js';

const c = (code) => (s) => (process.env.NO_COLOR || !process.stdout.isTTY ? String(s) : `\u001b[${code}m${s}\u001b[0m`);
const red = c('31'), yellow = c('33'), blue = c('36'), green = c('32'), gray = c('90'), bold = c('1');

export async function watchProject(root, { interval = 3, strict = false, config, json = false } = {}) {
  const abs = path.resolve(root);
  let dataDir = null;
  try { dataDir = loadProject(abs).dataDir; } catch (e) {
    console.error(red('✗ ') + '读不了这个工程：' + e.message);
    process.exitCode = 1;
    return;
  }
  let lastSignature = '';
  let running = false;
  let dirty = false;

  const signature = () => {
    try {
      const files = fs.readdirSync(dataDir).filter((f) => !f.endsWith('.bak'));
      let s = files.length + '|' + files.sort().join(',');
      for (const f of files) {
        try { s += '|' + fs.statSync(path.join(dataDir, f)).mtimeMs; } catch { /* 文件正在被写 */ }
      }
      return s;
    } catch { return ''; }
  };

  const check = () => {
    if (running) { dirty = true; return; }
    running = true;
    try {
      const project = loadProject(abs);
      const { issues, summary } = runBugChecks(project, { strict });
      const filtered = config ? applyConfigToIssues(issues, config) : issues;
      const counts = { error: 0, warning: 0, info: 0 };
      for (const i of filtered) counts[i.level]++;
      const stamp = new Date().toTimeString().slice(0, 8);
      if (json) {
        console.log(JSON.stringify({ at: stamp, stats: project.stats, summary, counts, issues: filtered }));
      } else {
        console.log('');
        console.log(`${gray(stamp)} ${bold('重新体检')} · ${project.stats.maps} 图 / ${project.stats.events} 事件 / ${project.stats.dialogues} 条对话`);
        const top = filtered.filter((i) => i.level !== 'info').slice(0, 12);
        for (const i of top) {
          const tag = i.level === 'error' ? red('ERROR') : yellow('WARN ');
          const w = i.where || {};
          const pos = [w.mapName ? `地图「${w.mapName}」` : '', w.eventName ? `事件「${w.eventName}」` : ''].filter(Boolean).join(' / ');
          console.log(`  ${tag} ${i.title} ${gray(pos)}  ${gray('[' + i.code + ']')}`);
        }
        console.log(`  ${red('error ' + counts.error)} · ${yellow('warning ' + counts.warning)} · ${blue('info ' + counts.info)}` +
          (filtered.length > top.length ? gray(`（只显示前 ${top.length} 条）`) : ''));
      }
    } catch (e) {
      console.error(red('✗ 体检出错：') + e.message);
    } finally {
      running = false;
      if (dirty) { dirty = false; setTimeout(check, 300); }
    }
  };

  lastSignature = signature();
  console.log(`${bold('rmtk')} ${green('watch')} · 正在守着 ${gray(dataDir)}`);
  console.log(gray(`每 ${interval} 秒检查一次改动，Ctrl+C 结束。`));
  check();

  const timer = setInterval(() => {
    const s = signature();
    if (s !== lastSignature) {
      lastSignature = s;
      check();
    }
  }, Math.max(1, interval) * 1000);

  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\n' + gray('已停止监视。'));
    process.exit(0);
  });
  // 常驻
  await new Promise(() => {});
}
