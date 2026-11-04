#!/usr/bin/env node
'use strict';

/**
 * PortDeck —— 本机端口总览台
 *
 * 扫描本机所有 TCP 监听端口，补上「用途 / 启动目录 / 访问链接 / 进程信息」，
 * 用一个网页看板集中展示，支持逐个或批量结束进程。
 * 只监听 127.0.0.1，无第三方依赖。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 全局安装时不能往 node_modules 里写数据，统一放用户目录；也可用环境变量覆盖
const DATA_DIR = process.env.PORTDECK_DATA_DIR || path.join(os.homedir(), '.portdeck');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
// 早期版本把备注写在项目目录里，启动时迁移一次
const LEGACY_NOTES_FILE = path.join(ROOT, 'data', 'notes.json');
const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT || 7799);
const ME = os.userInfo().username;

/* ------------------------------------------------------------------ */
/* 系统命令                                                           */
/* ------------------------------------------------------------------ */

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { maxBuffer: 8 * 1024 * 1024, timeout: 10_000, encoding: 'utf8', ...opts },
      (err, stdout) => resolve(stdout || '')
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 监听端口                                                            */
/* ------------------------------------------------------------------ */

async function listListening() {
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  const byKey = new Map();

  for (const line of out.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;

    // lsof 的 NAME 列形如 *:3000 / 127.0.0.1:1420 / [::1]:5000，行尾还会跟 (LISTEN)
    const nameToken = [...parts].reverse().find((t) => /:\d+$/.test(t));
    if (!nameToken) continue;

    const pid = Number(parts[1]);
    const port = Number(nameToken.slice(nameToken.lastIndexOf(':') + 1));
    if (!pid || !port) continue;

    const key = `${pid}:${port}`;
    let item = byKey.get(key);
    if (!item) {
      item = { pid, port, user: parts[2], procName: parts[0], addrs: new Set() };
      byKey.set(key, item);
    }
    item.addrs.add(nameToken.replace(/:\d+$/, ''));
  }

  return [...byKey.values()];
}

async function psSnapshot() {
  const out = await run('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,%cpu=,rss=,cputime=,command=']);
  const map = new Map();

  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    map.set(pid, {
      pid,
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      etime: m[4],
      // ps 的 %cpu 是进程生命周期内的平均值，只作为首次采样的兜底
      cpu: Number(m[5]),
      // rss 单位是 KB
      rssKb: Number(m[6]),
      cpuSeconds: cputimeToSeconds(m[7]),
      command: m[8].trim(),
    });
  }

  return map;
}

/** cputime 形如 0:12.34 / 4:23.78 / 1:02:03.45 */
function cputimeToSeconds(text) {
  const m = String(text).match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/* 用两次采样的 CPU 时间差算瞬时占用；ps 的 %cpu 对空闲进程永远是 0，没有参考价值 */
const cpuSamples = new Map();

function sampleCpu(ps, sampledAt) {
  const live = new Map();

  for (const [pid, info] of ps) {
    const current = info.cpuSeconds;
    if (current === null) continue;

    const prev = cpuSamples.get(pid);
    if (!prev) {
      cpuSamples.set(pid, { cpuSeconds: current, at: sampledAt });
      continue;
    }

    const windowMs = sampledAt - prev.at;
    // 窗口太短就保留旧样本，等下一次刷新再算，避免噪声
    if (windowMs < 1000) continue;

    const delta = current - prev.cpuSeconds;
    if (delta >= 0) live.set(pid, (delta / (windowMs / 1000)) * 100);
    cpuSamples.set(pid, { cpuSeconds: current, at: sampledAt });
  }

  for (const pid of [...cpuSamples.keys()]) {
    if (!ps.has(pid)) cpuSamples.delete(pid);
  }

  return live;
}

/** 批量取进程 cwd：lsof -a -p ... -d cwd -Fn */
async function cwdsFor(pids) {
  const result = new Map();
  const chunkSize = 40;

  for (let i = 0; i < pids.length; i += chunkSize) {
    const chunk = pids.slice(i, i + chunkSize);
    const args = ['-nP', '-a'];
    for (const pid of chunk) args.push('-p', String(pid));
    args.push('-d', 'cwd', '-Fn');

    const out = await run('lsof', args);
    let current = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) current = Number(line.slice(1));
      else if (line.startsWith('n') && current) result.set(current, line.slice(1));
    }
  }

  return result;
}

function ancestorChain(pid, ps) {
  const chain = new Set();
  let cur = pid;
  for (let i = 0; i < 40 && cur > 1; i++) {
    chain.add(cur);
    const parent = ps.get(cur);
    if (!parent) break;
    cur = parent.ppid;
  }
  return chain;
}

function descendantsOf(pid, ps) {
  const children = new Map();
  for (const p of ps.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }

  const out = [];
  const stack = [...(children.get(pid) || [])];
  while (stack.length) {
    const next = stack.pop();
    out.push(next);
    stack.push(...(children.get(next) || []));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 元信息推断                                                          */
/* ------------------------------------------------------------------ */

const PROJECT_MARKERS = [
  'package.json',
  'pnpm-workspace.yaml',
  '.git',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'requirements.txt',
];

function findProjectRoot(cwd) {
  if (!cwd) return null;
  const home = os.homedir();
  let dir = cwd;

  for (let i = 0; i < 12; i++) {
    if (dir === '/' || dir === home) break;
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const FRAMEWORKS = [
  [/\bvite\b/i, 'Vite'],
  [/\bnext\b/i, 'Next.js'],
  [/\bnuxt\b/i, 'Nuxt'],
  [/\breact-scripts\b/i, 'CRA'],
  [/\bwebpack\b/i, 'Webpack'],
  [/\bstorybook\b/i, 'Storybook'],
  [/\buvicorn\b/i, 'Uvicorn'],
  [/\bgunicorn\b/i, 'Gunicorn'],
  [/\bflask\b/i, 'Flask'],
  [/\bmanage\.py\b/i, 'Django'],
  [/\bhttp\.server\b/i, 'Python http.server'],
  [/\bhttp-server\b/i, 'http-server'],
  [/\/\.bin\/serve\b|\bnpx serve\b/i, 'serve'],
  [/\bnodemon\b/i, 'nodemon'],
  [/\btsx\b|\bts-node\b/i, 'ts-node'],
  [/\bdeno\b/i, 'Deno'],
  [/\bbun\b/i, 'Bun'],
  [/\bcargo\b/i, 'Cargo'],
  [/\bgo run\b/i, 'Go'],
  [/\bjava\b/i, 'Java'],
];

function detectFramework(command) {
  for (const [re, name] of FRAMEWORKS) {
    if (re.test(command)) return name;
  }
  return '';
}

// 系统 / IDE 常驻服务：展示但默认不允许关闭
// 系统常驻服务的判定：路径 + 可执行文件双条件，避免把 /Library 下的 Python 之类
// 的开发运行时误判成系统进程。
const SYSTEM_PATH_RE =
  /^(?:\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/Applications\/|\/Library\/Apple\/|\/Library\/PrivilegedHelperTools\/)/i;
const APP_BUNDLE_RE = /\.app\/Contents\//i;
const DEV_RUNTIME_RE = /^(?:node|python[\d.]*|ruby|java|deno|bun|php|go|perl)$/i;

// 家目录下的点目录（~/.xxx）通常是编辑器、AI 工具或语言运行时的工作区。
// 其中包管理器和运行时的安装目录要排除，否则从 ~/.nvm 启动的 node 也会被误判成工具服务。
const RUNTIME_HOME_RE = /^\/\.(?:nvm|fnm|volta|pyenv|rbenv|nodenv|local|bun|deno|npm|yarn|pnpm|cache|config|ssh)\//i;

function inHiddenHome(target) {
  if (!target || !target.startsWith(`${os.homedir()}/.`)) return false;
  return !RUNTIME_HOME_RE.test(target.slice(os.homedir().length));
}

function commandInHiddenHome(command) {
  return String(command)
    .split(/\s+/)
    .some((token) => token.startsWith('/') && inHiddenHome(token));
}

const DEV_RE =
  /\b(vite|next|nuxt|webpack|react-scripts|uvicorn|gunicorn|flask|django|manage\.py|http\.server|nodemon|tsx|ts-node|storybook|deno|bun|npm|pnpm|yarn|go run|cargo run|air)\b|--port[= ]|-p\s*\d+/;

function classify(command, cwd, projectRoot) {
  const exe = basenameOf(command);
  // 以 .app 包形式存在的 GUI 应用（Figma、Ollama 等）算系统服务；
  // 但 Python.app / 内嵌 node 这类开发运行时不算
  const isAppBundle = APP_BUNDLE_RE.test(command) && !DEV_RUNTIME_RE.test(exe);
  const inSystemArea =
    SYSTEM_PATH_RE.test(command) ||
    (cwd && /^(?:\/System\/|\/usr\/|\/Applications\/|\/Library\/Apple\/)/.test(cwd));

  if (isAppBundle || inSystemArea) return 'system';
  if (inHiddenHome(cwd) || commandInHiddenHome(command)) return 'system';
  if (DEV_RE.test(command) || projectRoot) return 'dev';
  return 'app';
}

function basenameOf(command) {
  if (!command) return '';
  // 形如 /Applications/Xxx Helper.app/Contents/MacOS/Xxx Helper 的路径带空格，单独取
  const appMatch = command.match(/\/([^/]+)\.app\/Contents\/(?:MacOS|Helpers)\/([^ ]+)/);
  if (appMatch) return appMatch[2];
  const first = command.trim().split(/\s+/)[0] || '';
  return path.basename(first.replace(/^["']|["']$/g, ''));
}

function etimeToSeconds(etime) {
  if (!etime) return 0;

  let days = 0;
  let rest = etime;
  const dayMatch = rest.match(/^(\d+)-(.+)$/);
  if (dayMatch) {
    days = Number(dayMatch[1]);
    rest = dayMatch[2];
  }

  const parts = rest.split(':').map(Number);
  let secs = 0;
  if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
  else secs = parts[0] || 0;

  return days * 86400 + secs;
}

/* ------------------------------------------------------------------ */
/* HTTP 探测（拿状态码和页面标题）                                      */
/* ------------------------------------------------------------------ */

const probeCache = new Map();
const PROBE_TTL = 30_000;

async function probeHttp(port, pid, kind) {
  const key = `${pid}:${port}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit.value;

  const value = { http: null, title: '' };

  if (kind !== 'system') {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1500),
        redirect: 'manual',
        headers: { accept: 'text/html,application/xhtml+xml,*/*' },
      });
      value.http = res.status;

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const text = (await res.text()).slice(0, 6000);
        const match = text.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
        if (match) value.title = match[1].trim().replace(/\s+/g, ' ');
      } else if (res.body) {
        await res.body.cancel();
      }
    } catch {
      // 非 HTTP 服务或超时：保持为空
    }
  }

  probeCache.set(key, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ */
/* 备注（用途）持久化                                                   */
/* ------------------------------------------------------------------ */

function readNotes() {
  try {
    return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeNotes(notes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${NOTES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2));
  fs.renameSync(tmp, NOTES_FILE);
}

/** 老版本把备注写在安装目录下，升级后搬到用户目录，只搬一次 */
function migrateLegacyNotes() {
  try {
    if (fs.existsSync(NOTES_FILE) || !fs.existsSync(LEGACY_NOTES_FILE)) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(LEGACY_NOTES_FILE, NOTES_FILE);
  } catch {
    // 迁移失败不影响启动，备注会重新生成
  }
}

/* ------------------------------------------------------------------ */
/* 快照                                                                */
/* ------------------------------------------------------------------ */

const KIND_ORDER = { dev: 0, app: 1, self: 2, system: 3 };

let cache = { at: 0, data: null, promise: null };

/** 本工具的其它实例（例如上次没关掉的那份），同样视为自身 */
function isSelfInstance(listener, cwd, command) {
  if (listener.pid === process.pid) return true;
  return cwd === ROOT && /\bnode\b/.test(command) && /server\.js/.test(command);
}

async function buildSnapshot() {
  const listeners = await listListening();
  const ps = await psSnapshot();
  const sampledAt = Date.now();
  const cpuNow = sampleCpu(ps, sampledAt);
  const selfChain = ancestorChain(process.pid, ps);
  const ownPgid = ps.get(process.pid)?.pgid;
  const pids = [...new Set(listeners.map((l) => l.pid))];
  const cwds = await cwdsFor(pids);
  const notes = readNotes();

  const ports = await Promise.all(
    listeners.map(async (listener) => {
      const info = ps.get(listener.pid) || {
        command: listener.procName,
        ppid: 0,
        pgid: 0,
        etime: '',
        cpu: 0,
        rssKb: 0,
        cpuSeconds: null,
      };
      // 端口所在进程通常还会带子进程（esbuild、tsc、子 worker），一起统计更接近真实占用
      const tree = descendantsOf(listener.pid, ps);
      const treeProcs = [listener.pid, ...tree].map((pid) => ps.get(pid)).filter(Boolean);
      const liveValues = treeProcs.map((p) => cpuNow.get(p.pid)).filter((v) => v !== undefined);
      // 首次采样（还没攒够两次数据）时退回 ps 的生命周期平均值
      const cpu = liveValues.length
        ? liveValues.reduce((sum, v) => sum + v, 0)
        : treeProcs.reduce((sum, p) => sum + (p.cpu || 0), 0);
      const rssKb = treeProcs.reduce((sum, p) => sum + (p.rssKb || 0), 0);
      const rawCwd = cwds.get(listener.pid) || null;
      // / 作为 cwd 没有信息量，按未知处理
      const cwd = rawCwd && rawCwd !== '/' ? rawCwd : null;
      const projectRoot = findProjectRoot(cwd);
      const dir = projectRoot || cwd;
      // 本工具（以及启动它的 AI / IDE 宿主）的祖先进程一律视为受保护对象
      const kind =
        isSelfInstance(listener, rawCwd, info.command)
          ? 'self'
          : selfChain.has(listener.pid)
            ? 'system'
            : classify(info.command, cwd, projectRoot);
      const probe = await probeHttp(listener.port, listener.pid, kind);
      const uptime = etimeToSeconds(info.etime);

      return {
        port: listener.port,
        pid: listener.pid,
        ppid: info.ppid,
        pgid: info.pgid,
        processName: basenameOf(info.command) || listener.procName,
        command: info.command,
        cwd,
        dir,
        project: dir ? path.basename(dir) : '',
        framework: detectFramework(info.command),
        kind,
        http: probe.http,
        title: probe.title,
        url: `http://localhost:${listener.port}`,
        startedAt: uptime ? Date.now() - uptime * 1000 : 0,
        cpu: Math.round(cpu * 10) / 10,
        cpuLive: liveValues.length > 0,
        rss: rssKb * 1024,
        procCount: treeProcs.length,
        user: listener.user,
        addrs: [...listener.addrs],
        note: notes[listener.port]?.note || '',
        noteUpdatedAt: notes[listener.port]?.updatedAt || 0,
        protected: selfChain.has(listener.pid) || listener.pid <= 1,
        killable:
          kind !== 'system' &&
          kind !== 'self' &&
          listener.user === ME &&
          listener.pid > 1 &&
          !selfChain.has(listener.pid),
        sameGroup: ownPgid !== undefined && info.pgid === ownPgid,
      };
    })
  );

  ports.sort((a, b) => {
    const diff = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    return diff !== 0 ? diff : a.port - b.port;
  });

  return { generatedAt: Date.now(), ports };
}

async function getSnapshot(force) {
  if (!force && cache.data && Date.now() - cache.at < 1200) return cache.data;
  if (cache.promise) return cache.promise;

  cache.promise = buildSnapshot()
    .then((data) => {
      cache = { at: Date.now(), data, promise: null };
      return data;
    })
    .catch((err) => {
      cache.promise = null;
      throw err;
    });

  return cache.promise;
}

/* ------------------------------------------------------------------ */
/* 结束进程                                                            */
/* ------------------------------------------------------------------ */

async function isStillListening(pid, port) {
  const listeners = await listListening();
  return listeners.some((l) => l.pid === pid && l.port === port);
}

async function waitPortClosed(pid, port, timeout) {
  const deadline = Date.now() + timeout;
  do {
    await sleep(220);
    if (!(await isStillListening(pid, port))) return true;
  } while (Date.now() < deadline);
  return false;
}

async function killPort(pid, port) {
  const listeners = await listListening();
  const target = listeners.find((l) => l.pid === pid && l.port === port);
  if (!target) return { ok: false, error: '端口已不在监听（可能已被关闭）' };

  if (target.user !== ME) return { ok: false, error: `该进程属于 ${target.user}，拒绝关闭` };

  const ps = await psSnapshot();
  const selfChain = ancestorChain(process.pid, ps);
  if (selfChain.has(pid)) return { ok: false, error: '这个进程是本工具/AI 的父进程，拒绝关闭' };

  const info = ps.get(pid);
  const ownPgid = ps.get(process.pid)?.pgid;
  // 只有当目标自己是进程组组长、且不是我们所在组时才整组结束，顺带收掉 npm/vite 子进程
  const groupKill = Boolean(info && info.pgid === pid && info.pgid !== ownPgid && !selfChain.has(info.pgid));
  const kids = info ? descendantsOf(pid, ps) : [];

  const send = (signal) => {
    if (groupKill) {
      try {
        process.kill(-pid, signal);
      } catch {
        /* 组里已没有成员 */
      }
    }
    for (const child of [pid, ...kids]) {
      try {
        process.kill(child, signal);
      } catch {
        /* 已退出 */
      }
    }
  };

  send('SIGTERM');
  if (await waitPortClosed(pid, port, 3000)) {
    return { ok: true, escalated: false, killedPids: kids.length + 1 };
  }

  send('SIGKILL');
  if (await waitPortClosed(pid, port, 2000)) {
    return { ok: true, escalated: true, killedPids: kids.length + 1 };
  }

  return { ok: false, error: '进程仍未退出，可能被 launchd 之类的守护进程拉起' };
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 防 CSRF：只接受本页面发起的写请求 */
function isTrustedRequest(req) {
  if (req.headers['x-portdeck-request'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);

  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendText(res, 403, 'Forbidden');
  }

  fs.readFile(file, (err, buf) => {
    if (err) return sendText(res, 404, 'Not Found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  try {
    if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);

    if (req.method === 'GET' && pathname === '/api/ports') {
      const data = await getSnapshot(url.searchParams.get('force') === '1');
      return sendJson(res, 200, { ok: true, ...data });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: '拒绝非法来源的请求' });

    const body = await readBody(req);

    if (pathname === '/api/kill') {
      const pid = Number(body.pid);
      const port = Number(body.port);
      if (!Number.isInteger(pid) || !Number.isInteger(port)) {
        return sendJson(res, 400, { ok: false, error: 'pid / port 不合法' });
      }
      const result = await killPort(pid, port);
      probeCache.delete(`${pid}:${port}`);
      return sendJson(res, result.ok ? 200 : 409, result);
    }

    if (pathname === '/api/kill-batch') {
      const targets = Array.isArray(body.targets) ? body.targets.slice(0, 50) : [];
      const results = [];
      for (const item of targets) {
        const pid = Number(item.pid);
        const port = Number(item.port);
        if (!Number.isInteger(pid) || !Number.isInteger(port)) continue;
        const result = await killPort(pid, port);
        probeCache.delete(`${pid}:${port}`);
        results.push({ port, pid, ...result });
      }
      return sendJson(res, 200, {
        ok: true,
        results,
        failed: results.filter((r) => !r.ok).length,
      });
    }

    if (pathname === '/api/note') {
      const port = Number(body.port);
      if (!Number.isInteger(port)) return sendJson(res, 400, { ok: false, error: 'port 不合法' });

      const notes = readNotes();
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
      if (note) notes[port] = { note, updatedAt: Date.now() };
      else delete notes[port];
      writeNotes(notes);
      return sendJson(res, 200, { ok: true, note });
    }

    if (pathname === '/api/open') {
      const port = Number(body.port);
      if (!Number.isInteger(port)) return sendJson(res, 400, { ok: false, error: 'port 不合法' });
      execFile('open', [`http://localhost:${port}`]);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/open-dir') {
      const dir = String(body.dir || '');
      if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return sendJson(res, 400, { ok: false, error: '目录不存在' });
      }
      execFile('open', [dir]);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message || '服务内部错误' });
  }
});

async function handlePortBusy(port, attempt) {
  // 已经有一份在跑就直接打开它，避免同时起多个实例
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ports`, { signal: AbortSignal.timeout(800) });
    const data = await res.json();
    if (Array.isArray(data.ports)) {
      const addr = `http://${HOST}:${port}`;
      console.log(`  PortDeck 已在 ${addr} 运行，直接打开该页面`);
      if (process.env.NO_OPEN !== '1') execFile('open', [addr]);
      return process.exit(0);
    }
  } catch {
    // 占用端口的不是本工具
  }

  if (attempt < 10) return start(port + 1, attempt + 1);
  console.error('PortDeck 启动失败：连续 10 个端口都被占用');
  process.exit(1);
}

function start(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') return handlePortBusy(port, attempt);
    console.error('PortDeck 启动失败：', err.message);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const addr = `http://${HOST}:${port}`;
    console.log(`\n  PortDeck 已启动  ${addr}\n  仅监听本机回环地址，Ctrl+C 退出\n`);
    if (process.env.NO_OPEN !== '1') execFile('open', [addr]);
  });
}

migrateLegacyNotes();
start(BASE_PORT);
