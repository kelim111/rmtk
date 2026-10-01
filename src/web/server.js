/* =========================================================================
   本地网页版：拖一个 RPG Maker 工程文件夹（或 zip）进去，就地出报告。
   零依赖 —— 只用 node 自带的 http / fs / os / zlib。
     GET  /               上传界面
     POST /api/analyze    上传工程 → 返回统计 + Bug + 地图图 + 文档（?format=md 直接给 Markdown）
     POST /api/translate  上传工程 → 返回语言包 zip
     GET  /api/health     健康检查
   ========================================================================= */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipToDir, findProjectRoot, writeZip } from './zip.js';
import { loadProject } from '../model.js';
import { runBugChecks } from '../analyzers/bugs.js';
import { buildGraph, graphToMermaid, questToMermaid } from '../analyzers/graph.js';
import { extractDialogues, makeMvLanguagePackPlugin, makeRubyLanguagePatch } from '../analyzers/dialogue.js';
import { renderMarkdownReport } from '../report/markdown.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------ multipart */

function parseMultipart(buf, boundary) {
  const files = [];
  const delim = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf(delim, pos);
    if (start === -1) break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const header = buf.subarray(start + delim.length, headEnd).toString('utf8');
    const nextBoundary = buf.indexOf(delim, headEnd);
    const bodyEnd = nextBoundary === -1 ? buf.length : nextBoundary - 2;
    const body = buf.subarray(headEnd + 4, bodyEnd);
    const nameMatch = /filename="([^"]*)"/.exec(header);
    if (nameMatch && nameMatch[1]) files.push({ filename: nameMatch[1], data: body });
    if (nextBoundary === -1) break;
    pos = nextBoundary;
  }
  return files;
}

function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('上传的东西太大了（>512MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function saveUpload(files, dir) {
  for (const f of files) {
    if (!f.filename) continue;
    const safe = path.normalize(f.filename).replace(/^(\.\.[/\\])+/, '');
    const target = path.join(dir, safe);
    if (!path.resolve(target).startsWith(path.resolve(dir))) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
  return dir;
}

async function projectFromRequest(req) {
  const body = await readBody(req);
  const ct = String(req.headers['content-type'] || '');
  const isZipMagic = body.length > 4 && body[0] === 0x50 && body[1] === 0x4b;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtk-'));
  if (ct.includes('multipart/form-data')) {
    const boundary = /boundary=([^;]+)/.exec(ct)?.[1];
    if (!boundary) throw new Error('multipart 里没有 boundary');
    const files = parseMultipart(body, boundary);
    const zipFile = files.find((f) => f.filename && /\.zip$/i.test(f.filename));
    if (zipFile) unzipToDir(zipFile.data, workDir);
    else saveUpload(files.filter((f) => f.filename), workDir);
  } else if (isZipMagic) {
    unzipToDir(body, workDir);
  } else {
    throw new Error('请上传工程文件夹，或者一个 zip 包');
  }
  const root = findProjectRoot(workDir);
  return { project: loadProject(root), workDir };
}

export async function startServer({ port = 8787, open = false } = {}) {
  const ui = fs.readFileSync(path.join(HERE, 'ui.html'), 'utf8');
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ui);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, version: '0.1.0' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/analyze') {
        const { project, workDir } = await projectFromRequest(req);
        const bugs = runBugChecks(project);
        const graph = buildGraph(project);
        const dialogues = extractDialogues(project);
        const markdown = renderMarkdownReport(project);
        fs.rmSync(workDir, { recursive: true, force: true });
        if (url.searchParams.get('format') === 'md') {
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
          res.end(markdown);
          return;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
          engine: project.engine,
          label: project.label,
          title: project.system.title,
          experimental: !!project.experimental,
          stats: project.stats,
          bugs,
          mapGraph: graph.mapGraph,
          quest: graph.quest,
          mermaid: { map: graphToMermaid(graph), quest: questToMermaid(graph) },
          dialogues: dialogues.slice(0, 500),
          dialogueTotal: dialogues.length,
          missingAssets: project.assets.missing,
          markdown
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/translate') {
        const { project, workDir } = await projectFromRequest(req);
        const rows = extractDialogues(project).filter((d) => d.text && d.text.trim());
        const dict = {};
        for (const r of rows) if (!(r.text in dict)) dict[r.text] = r.text;
        const csv = ['key,mapName,eventName,text'].concat(rows.map((r) =>
          [r.key, r.mapName, r.eventName, r.text].map((x) => '"' + String(x ?? '').replace(/"/g, '""') + '"').join(','))).join('\n');
        const files = {
          'translation.json': JSON.stringify(dict, null, 2),
          'dialogue.csv': '\ufeff' + csv,
          'HOWTO.txt': [
            '这是「抽取结果」：translation.json 里把每条原文都留了空位（值暂时等于原文）。',
            '把值换成译文，或者直接在命令行跑真正的翻译：',
            '',
            '  rmtk translate <工程目录> --translator openai --to zh_CN -o out      # 生成语言包',
            '  rmtk translate <工程目录> --translator openai --to zh_CN --apply     # 直接写回工程',
            '  rmtk translate <工程目录> --dict 我的对照表.json --apply             # 用自己的对照表回填',
            ''
          ].join('\n')
        };
        if (project.engine === 'MV' || project.engine === 'MZ') {
          files['RMTK_Translation.js'] = makeMvLanguagePackPlugin(dict);
        } else if (project.engine !== '2000' && project.engine !== '2003') {
          files['rmtk_translation.rb'] = makeRubyLanguagePatch(dict);
        }
        const zip = writeZip(files);
        fs.rmSync(workDir, { recursive: true, force: true });
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="rmtk-language-pack.zip"'
        });
        res.end(zip);
        return;
      }
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  };
  const server = http.createServer(handler);

  // 端口被占了就往后找一个（最多试 20 个）
  let actual = port;
  for (let i = 0; i < 20; i++) {
    const ok = await new Promise((resolve) => {
      const onError = (e) => { server.removeListener('listening', onListening); resolve(e.code === 'EADDRINUSE' ? false : (() => { throw e; })()); };
      const onListening = () => { server.removeListener('error', onError); resolve(true); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(actual);
    });
    if (ok) break;
    actual++;
  }
  const url = `http://localhost:${actual}`;
  console.log(`rmtk 网页版已启动： ${url}`);
  console.log('把 RPG Maker 工程文件夹（或 zip）拖进去就行。Ctrl+C 结束。');
  if (open) openBrowser(url);
  return server;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就算了，用户自己点链接 */ }
}
