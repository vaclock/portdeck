'use strict';

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const SORT_KEYS = ['port', 'cpu', 'mem'];

function readSort() {
  const raw = localStorage.getItem('portdeck:sort') || '';
  const [key, dir] = raw.split(':');
  if (!SORT_KEYS.includes(key)) return { key: null, dir: 'desc' };
  return { key, dir: dir === 'asc' ? 'asc' : 'desc' };
}

const state = {
  ports: [],
  query: '',
  auto: localStorage.getItem('portdeck:auto') !== 'off',
  showSystem: localStorage.getItem('portdeck:showSystem') === 'on',
  sort: readSort(),
  signature: '',
  refreshing: false,
  generatedAt: 0,
  renderedKeys: null,
};


const INTERVAL_MS = 5000;
const KIND_LABEL = { dev: '开发', app: '应用', self: '本工具', system: '系统' };

const $ = (sel) => document.querySelector(sel);
const els = {
  meter: $('#meter'),
  meterCaption: $('#meter-caption'),
  stamp: $('#stamp'),
  rows: $('#rows'),
  empty: $('#empty'),
  search: $('#search'),
  auto: $('#auto'),
  showSystem: $('#show-system'),
  folded: $('#folded'),
  foldedCount: $('#folded-count'),
  searchClear: $('#search-clear'),
  refresh: $('#refresh'),
  killDev: $('#kill-dev'),
  toasts: $('#toasts'),
  modal: $('#modal'),
  modalTitle: $('#modal-title'),
  modalBody: $('#modal-body'),
  modalOk: $('#modal-ok'),
  modalCancel: $('#modal-cancel'),
};

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', 'x-portdeck-request': '1' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function fmtUptime(ms) {
  if (!ms || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分`;
  return `${Math.max(total, 1)}秒`;
}

function fmtMem(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

function fmtCpu(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function cpuClass(value) {
  if (value >= 80) return 'hot';
  if (value >= 30) return 'warm';
  return '';
}

function cpuTitle(port) {
  return port.cpuLive
    ? '两次刷新之间的平均 CPU 占用（含子进程）'
    : '进程生命周期内的平均 CPU 占用；下次刷新后转为实时值';
}

function prettyPath(dir) {
  if (!dir) return '';
  return dir.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}

/** 路径中部截断：保证最后的目录名完整，前面的层级按剩余宽度压缩 */
function middlePath(dir, max = 36) {
  const pretty = prettyPath(dir);
  if (pretty.length <= max) return pretty;

  const parts = pretty.split('/');
  const last = parts.pop();
  const head = parts.join('/');

  if (last.length + 2 >= max) return `…/${last}`;
  return `${head.slice(0, max - last.length - 2)}…/${last}`;
}

function autoPurpose(port) {
  if (port.kind === 'self') return 'PortDeck 端口总览台';
  if (port.title) return port.title;
  if (port.kind === 'dev') {
    return port.framework ? `${port.framework} 开发服务` : '开发服务';
  }
  if (port.kind === 'system') return `${port.processName || '常驻进程'} 系统服务`;
  return port.framework ? `${port.framework} 服务` : `${port.processName} 服务`;
}

function displayPurpose(port) {
  return port.note || autoPurpose(port);
}

function needleOf(port) {
  return [port.port, port.purposeCache, port.dir, port.project, port.processName, port.command, port.title]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="bar"></span><span>${escapeHtml(message)}</span>`;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

function isEditing() {
  const el = document.activeElement;
  return Boolean(el && el.dataset && el.dataset.noteEditor === '1');
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function visiblePorts() {
  const q = state.query.trim().toLowerCase();

  // 搜索时跨全部分类查找，平时把系统常驻服务折叠起来，避免盖住真正的开发服务
  let list = state.ports;
  if (q) list = list.filter((p) => needleOf(p).includes(q));
  else if (!state.showSystem) list = list.filter((p) => p.kind !== 'system');

  return list;
}

function sortPorts(list) {
  const { key, dir } = state.sort;
  if (!key) return list;

  const value = (p) => (key === 'port' ? p.port : key === 'cpu' ? p.cpu || 0 : p.rss || 0);
  const sign = dir === 'asc' ? 1 : -1;

  // 数值相同按端口升序兜底，保证顺序稳定
  return [...list].sort((a, b) => (value(a) - value(b)) * sign || a.port - b.port);
}

function renderSortIndicators() {
  document.querySelectorAll('.grid thead [data-sort]').forEach((th) => {
    const active = state.sort.key === th.dataset.sort;
    th.dataset.dir = active ? state.sort.dir : '';
    th.setAttribute(
      'aria-sort',
      active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
    );
  });
}

function renderMeter() {
  els.meter.innerHTML = state.ports
    .map(
      (p) =>
        `<span class="seg seg-${p.kind}" title="${escapeHtml(`${p.port}　${displayPurpose(p)}`)}"></span>`
    )
    .join('');
  updateMeterCaption();
}

function updateMeterCaption() {
  if (!state.ports.length) {
    els.meterCaption.textContent = '还没有监听到端口';
    return;
  }

  const counts = { dev: 0, app: 0, self: 0, system: 0 };
  for (const p of state.ports) counts[p.kind] = (counts[p.kind] || 0) + 1;

  const devMem = state.ports.filter((p) => p.kind === 'dev').reduce((sum, p) => sum + (p.rss || 0), 0);

  const legend = [
    ['dev', '开发', counts.dev],
    ['self', '工具', counts.self],
    ['app', '应用', counts.app],
    ['system', '系统', counts.system],
  ]
    .filter((entry) => entry[2] > 0)
    .map(([kind, label, n]) => `<span class="lg"><i class="sw seg-${kind}"></i>${label} ${n}</span>`)
    .join('');

  els.meterCaption.innerHTML = `${legend}${
    devMem
      ? `<span class="lg lg-mem" title="所有开发服务（含子进程）的 RSS 合计">内存 ${fmtMem(devMem)}</span>`
      : ''
  }`;
}

/* 资源数值每次刷新都会变，单独就地更新，避免整表重绘导致闪烁 */
function updateResourceCells() {
  for (const port of state.ports) {
    const key = `${port.pid}:${port.port}`;

    const cpuEl = document.querySelector(`[data-cpu="${key}"] .res-cpu`);
    if (cpuEl) {
      cpuEl.textContent = fmtCpu(port.cpu);
      cpuEl.className = `res-cpu ${cpuClass(port.cpu)}`.trim();
      cpuEl.title = cpuTitle(port);
    }

    const memEl = document.querySelector(`[data-mem="${key}"] .res-mem`);
    if (memEl) {
      memEl.textContent = fmtMem(port.rss);
      memEl.title = `含 ${port.procCount || 1} 个进程的 RSS`;
    }
  }

  updateMeterCaption();
}

function rowHtml(port, index = 0, isNew = false) {
  const purpose = displayPurpose(port);
  const isAuto = !port.note;
  const kindLabel = KIND_LABEL[port.kind] || port.kind;

  const statusText = port.http
    ? String(port.http)
    : port.kind === 'system'
      ? '未探测'
      : '非 HTTP';

  // 系统服务的 cwd 基本都是 / 或应用包内部，没有参考价值
  const dirCell =
    port.dir && port.kind !== 'system'
      ? `<div class="dir">
         <span class="dir-name" data-action="open-dir" data-dir="${escapeHtml(port.dir)}" title="在 Finder 中打开">${escapeHtml(port.project)}</span>
         <span class="dir-path" title="${escapeHtml(port.dir)}">${escapeHtml(middlePath(port.dir))}</span>
       </div>`
      : `<span class="dir-none">—</span>`;

  const startHint = port.startedAt
    ? `<span data-started="${port.startedAt}">${fmtUptime(Date.now() - port.startedAt)}</span>`
    : '未知';

  const lockedReason =
    port.kind === 'system'
      ? '系统 / 工具常驻服务，不受一键关闭影响'
      : port.kind === 'self'
        ? '这是 PortDeck 自己的服务'
        : '该进程受保护（本工具 / AI 的父进程）';
  const killAttrs = port.killable ? '' : 'disabled';
  const killTitle = port.killable ? '结束该进程' : lockedReason;
  const killLabel = port.killable ? '关闭' : '锁定';

  return `
    <tr data-key="${port.pid}:${port.port}" class="${isNew ? 'row-enter' : ''}" style="--i:${index}">
      <td>
        <div class="port-line">
          <span class="lamp ${port.kind}"></span>
          <span class="port">${port.port}</span>
        </div>
        <div class="kindline">
          <span class="kind ${port.kind}">${kindLabel}</span>
          ${port.framework ? `<span>${escapeHtml(port.framework)}</span>` : ''}
        </div>
      </td>
      <td>
        <div class="purpose">
          <span class="purpose-text ${isAuto ? '' : 'is-note'}"
                data-action="edit-note"
                title="${escapeHtml(isAuto ? '点击填写用途，会长期记住' : '点击修改用途')}">${escapeHtml(purpose)}</span>
        </div>
      </td>
      <td>${dirCell}</td>
      <td>
        <div class="link-cell">
          <a class="link-main" href="${port.url}" target="_blank" rel="noreferrer">localhost:${port.port}</a>
          <span class="link-sub ${port.http && port.http >= 400 ? 'bad' : ''}">
            <span>${statusText}</span>
            ${port.title ? `<span class="ttl">${escapeHtml(port.title.slice(0, 28))}</span>` : ''}
          </span>
        </div>
      </td>
      <td class="proc-cell">
        <div class="proc">
          <span class="proc-name" title="${escapeHtml(port.command)}">${escapeHtml(port.processName)}</span>
          <span class="proc-meta">PID ${port.pid} · ${startHint}</span>
        </div>
      </td>
      <td class="num-cell" data-cpu="${port.pid}:${port.port}">
        <span class="res-cpu ${cpuClass(port.cpu)}" title="${cpuTitle(port)}">${fmtCpu(port.cpu)}</span>
      </td>
      <td class="num-cell" data-mem="${port.pid}:${port.port}">
        <span class="res-mem" title="含 ${port.procCount || 1} 个进程的 RSS">${fmtMem(port.rss)}</span>
      </td>
      <td>
        <div class="actions">
          <button class="icon-btn" data-action="open" data-port="${port.port}" title="在浏览器打开">打开</button>
          <button class="icon-btn" data-action="copy" data-url="${port.url}" title="复制链接">复制</button>
          <button class="icon-btn kill" data-action="kill" ${killAttrs} title="${escapeHtml(killTitle)}">${killLabel}</button>
        </div>
      </td>
    </tr>
  `;
}

function render() {
  renderMeter();
  renderSortIndicators();

  const list = sortPorts(visiblePorts());
  const first = state.renderedKeys === null;
  const seen = state.renderedKeys || new Set();

  // 只在第一次渲染和确实新增的端口上做入场动画，避免每次刷新整表跳动
  els.rows.innerHTML = list
    .map((port, i) => rowHtml(port, first ? i : 0, first || !seen.has(`${port.pid}:${port.port}`)))
    .join('');

  state.renderedKeys = new Set(state.ports.map((p) => `${p.pid}:${p.port}`));
  els.empty.hidden = list.length > 0;

  if (!els.empty.hidden) {
    if (!state.ports.length) {
      els.empty.innerHTML = `<p class="empty-title">当前没有监听中的端口</p><p class="empty-desc">启动一个服务后再刷新看看。</p>`;
    } else if (state.query.trim()) {
      els.empty.innerHTML = `<p class="empty-title">没有匹配的端口</p><p class="empty-desc">换个关键词试试。</p>`;
    } else {
      els.empty.innerHTML = `
        <p class="empty-title">没有正在运行的开发服务</p>
        <p class="empty-desc">系统服务已折叠，<a href="#" data-action="toggle-system">展开查看</a>。</p>`;
    }
  }

  const hiddenSystem = state.ports.filter((p) => p.kind === 'system').length;
  const showFolded = !state.showSystem && !state.query.trim() && hiddenSystem > 0 && list.length > 0;
  els.folded.hidden = !showFolded;
  if (showFolded) els.foldedCount.textContent = `${hiddenSystem} 个系统服务已折叠`;

  els.killDev.disabled = !state.ports.some((p) => p.killable && p.kind === 'dev');
  updateMeta();
}

function updateMeta() {
  if (!state.generatedAt) return;
  const time = new Date(state.generatedAt).toLocaleTimeString('zh-CN', { hour12: false });
  els.stamp.textContent = `更新于 ${time}`;
}

/* 每秒刷新「已运行」时长，不重绘整表 */
setInterval(() => {
  document.querySelectorAll('[data-started]').forEach((el) => {
    el.textContent = fmtUptime(Date.now() - Number(el.dataset.started));
  });
}, 1000);

/* ------------------------------------------------------------------ */
/* 数据刷新                                                            */
/* ------------------------------------------------------------------ */

async function refresh(force = false) {
  if (state.refreshing || isEditing()) return;
  state.refreshing = true;
  try {
    const data = await api(`/api/ports${force ? '?force=1' : ''}`);
    state.ports = (data.ports || []).map((p) => ({ ...p, purposeCache: displayPurpose(p) }));
    state.generatedAt = data.generatedAt;

    const signature = JSON.stringify(
      state.ports.map((p) => [p.pid, p.port, p.note, p.kind, p.http, p.title, p.dir, p.killable, p.framework])
    );
    if (signature !== state.signature) {
      state.signature = signature;
      render();
    } else {
      updateResourceCells();
      updateMeta();

      // 按资源排序时，数值变化可能改变顺序，顺序真变了才重排
      if (state.sort.key) {
        const current = [...els.rows.children].map((tr) => tr.dataset.key).join('|');
        const next = sortPorts(visiblePorts())
          .map((p) => `${p.pid}:${p.port}`)
          .join('|');
        if (current !== next) render();
      }
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    state.refreshing = false;
  }
}

/* ------------------------------------------------------------------ */
/* 编辑用途                                                            */
/* ------------------------------------------------------------------ */

function startEditNote(cell, port) {
  const input = document.createElement('input');
  input.className = 'note-input';
  input.value = port.note || autoPurpose(port);
  input.dataset.noteEditor = '1';
  input.placeholder = '例如：wenku 后台前端调试';

  const parent = cell.querySelector('.purpose');
  parent.innerHTML = '';
  parent.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;

    if (!save) {
      input.blur();
      render();
      return;
    }

    const value = input.value.trim();
    const note = value && value !== autoPurpose(port) ? value : '';
    try {
      await api('/api/note', { method: 'POST', body: JSON.stringify({ port: port.port, note }) });
      port.note = note;
      state.signature = '';
      state.ports = state.ports.map((p) =>
        p.port === port.port && p.pid === port.pid ? { ...p, note, purposeCache: note || autoPurpose(p) } : p
      );
      render();
    } catch (err) {
      toast(err.message, 'err');
      render();
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit(true);
    if (event.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

/* ------------------------------------------------------------------ */
/* 确认弹窗                                                            */
/* ------------------------------------------------------------------ */

let modalResolve = null;

function confirmDialog({ title, bodyHtml, okText = '确认关闭' }) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = bodyHtml;
  els.modalOk.textContent = okText;
  els.modal.hidden = false;
  els.modalOk.focus();

  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(result) {
  els.modal.hidden = true;
  if (modalResolve) {
    const resolve = modalResolve;
    modalResolve = null;
    resolve(result);
  }
}

els.modalCancel.addEventListener('click', () => closeModal(false));
els.modalOk.addEventListener('click', () => closeModal(true));
els.modal.addEventListener('click', (event) => {
  if (event.target === els.modal) closeModal(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.modal.hidden) closeModal(false);
});

/* ------------------------------------------------------------------ */
/* 关闭端口                                                            */
/* ------------------------------------------------------------------ */

function killDetailHtml(port) {
  const siblings = state.ports.filter((p) => p.pid === port.pid && p.port !== port.port).map((p) => p.port);
  const cmd = port.command || '未知';
  const shortCmd = cmd.length > 150 ? `${cmd.slice(0, 150)}…` : cmd;

  return `
    <p>即将结束端口 <b>${port.port}</b> 上的进程，并连带它的子进程。</p>
    <dl class="kv">
      <dt>用途</dt><dd>${escapeHtml(displayPurpose(port))}</dd>
      <dt>目录</dt><dd>${escapeHtml(port.dir || '未知')}</dd>
      <dt>命令</dt><dd>${escapeHtml(shortCmd)}</dd>
      <dt>PID</dt><dd>${port.pid}</dd>
    </dl>
    ${
      siblings.length
        ? `<div class="warn">同一进程还占用了 ${siblings.join('、')}，会一起关闭。</div>`
        : ''
    }
    <div class="warn" style="margin-top:8px">如果这个服务是被 npm / vite 的 watcher 拉起的，关闭后可能被父进程重启。</div>
  `;
}

async function killOne(port, { silent = false } = {}) {
  if (!silent) {
    const ok = await confirmDialog({
      title: `关闭端口 ${port.port}？`,
      bodyHtml: killDetailHtml(port),
    });
    if (!ok) return false;
  }

  const row = document.querySelector(`tr[data-key="${port.pid}:${port.port}"]`);
  if (row) row.classList.add('leaving');

  try {
    await api('/api/kill', { method: 'POST', body: JSON.stringify({ pid: port.pid, port: port.port }) });
    state.signature = '';
    await refresh(true);
    toast(`已关闭 ${port.port}（${displayPurpose(port)}）`);
    return true;
  } catch (err) {
    if (row) row.classList.remove('leaving');
    toast(err.message, 'err');
    state.signature = '';
    await refresh(true);
    return false;
  }
}

async function killAllDev() {
  // 同一 PID 可能占多个端口，按 PID 去重，避免重复下发
  const seen = new Set();
  const targets = state.ports.filter((p) => {
    if (!p.killable || p.kind !== 'dev' || seen.has(p.pid)) return false;
    seen.add(p.pid);
    return true;
  });
  if (!targets.length) return toast('没有可关闭的开发服务');

  const preview = targets
    .slice(0, 8)
    .map((p) => `<li>${p.port} · ${escapeHtml(displayPurpose(p))}</li>`)
    .join('');

  const ok = await confirmDialog({
    title: `关闭全部 ${targets.length} 个开发服务？`,
    bodyHtml: `
      <p>下面这些端口上的进程会被结束：</p>
      <ul>${preview}${targets.length > 8 ? `<li>…等共 ${targets.length} 个</li>` : ''}</ul>
      <div class="warn" style="margin-top:12px">系统与 IDE 常驻服务、本工具自身不受影响。</div>
    `,
    okText: `全部关闭`,
  });
  if (!ok) return;

  els.killDev.disabled = true;
  try {
    const data = await api('/api/kill-batch', {
      method: 'POST',
      body: JSON.stringify({ targets: targets.map((p) => ({ pid: p.pid, port: p.port })) }),
    });
    const failed = data.results.filter((r) => !r.ok);
    state.signature = '';
    await refresh(true);
    if (failed.length) {
      toast(`关闭 ${data.results.length - failed.length} 个，${failed.length} 个失败：${failed[0].error}`, 'err');
    } else {
      toast(`已关闭 ${data.results.length} 个开发服务`);
    }
  } catch (err) {
    toast(err.message, 'err');
    els.killDev.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

els.rows.addEventListener('click', async (event) => {  const target = event.target.closest('[data-action]');
  if (!target) return;

  const port = state.ports.find((p) => `${p.pid}:${p.port}` === target.closest('tr')?.dataset.key);
  if (!port) return;

  switch (target.dataset.action) {
    case 'edit-note': {
      startEditNote(target.closest('td'), port);
      break;
    }
    case 'open': {
      await api('/api/open', { method: 'POST', body: JSON.stringify({ port: port.port }) }).catch((err) =>
        toast(err.message, 'err')
      );
      break;
    }
    case 'copy': {
      try {
        await navigator.clipboard.writeText(port.url);
        toast(`已复制 ${port.url}`);
      } catch {
        toast('复制失败，请手动选择链接', 'err');
      }
      break;
    }
    case 'open-dir': {
      const dir = target.dataset.dir;
      api('/api/open-dir', { method: 'POST', body: JSON.stringify({ dir }) }).catch((err) => toast(err.message, 'err'));
      break;
    }
    case 'kill': {
      killOne(port);
      break;
    }
  }
});

document.querySelector('.grid thead').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-action="sort"]');
  if (!btn) return;

  const key = btn.dataset.key;
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    // 数值列先看最大的，端口列先看最小的
    state.sort = { key, dir: key === 'port' ? 'asc' : 'desc' };
  }

  localStorage.setItem('portdeck:sort', `${state.sort.key}:${state.sort.dir}`);
  render();
});

els.search.addEventListener('input', () => {
  state.query = els.search.value;
  els.searchClear.hidden = !state.query;
  render();
});

els.searchClear.addEventListener('click', () => {
  els.search.value = '';
  state.query = '';
  els.searchClear.hidden = true;
  els.search.focus();
  render();
});

els.auto.checked = state.auto;
els.auto.addEventListener('change', () => {
  state.auto = els.auto.checked;
  localStorage.setItem('portdeck:auto', state.auto ? 'on' : 'off');
  updateMeta();
});

function setShowSystem(value) {
  state.showSystem = value;
  els.showSystem.checked = value;
  localStorage.setItem('portdeck:showSystem', value ? 'on' : 'off');
  render();
}

els.showSystem.checked = state.showSystem;
els.showSystem.addEventListener('change', () => setShowSystem(els.showSystem.checked));

for (const root of [els.empty, els.folded]) {
  root.addEventListener('click', (event) => {
    if (!event.target.closest('[data-action="toggle-system"]')) return;
    event.preventDefault();
    setShowSystem(true);
  });
}

els.refresh.addEventListener('click', () => refresh(true));
els.killDev.addEventListener('click', killAllDev);

setInterval(() => {
  if (state.auto && !document.hidden) refresh();
}, INTERVAL_MS);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh(true);
});

refresh(true);
