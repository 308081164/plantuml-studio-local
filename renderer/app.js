const DEFAULT_SOURCE = `@startuml
title 示例
Alice -> Bob : 本地渲染
Bob --> Alice : OK
@enduml
`;

const $ = (id) => document.getElementById(id);

/** 当前选择的项目根目录（与主进程配置 lastProjectRoot 同步） */
let selectedProjectRoot = '';

function setStatus(text, ok) {
  const el = $('status');
  el.textContent = text;
  el.classList.remove('status--ok', 'status--error');
  if (ok === true) el.classList.add('status--ok');
  else if (ok === false) el.classList.add('status--error');
}

function showErrors(lines) {
  const box = $('errors');
  if (!lines.length) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.textContent = lines.join('\n');
  box.classList.remove('hidden');
}

function setAgentLog(text, visible) {
  const el = $('agent-log');
  el.textContent = text || '';
  el.classList.toggle('hidden', !visible);
}

function clearPreview() {
  $('preview-placeholder').classList.remove('hidden');
  $('preview-img').classList.add('hidden');
  $('preview-svg').classList.add('hidden');
  $('preview-svg').innerHTML = '';
  $('preview-img').removeAttribute('src');
}

async function getBase() {
  if (!window.studio?.getApiBase) {
    throw new Error('预加载脚本未就绪');
  }
  const base = await window.studio.getApiBase();
  if (!base) throw new Error('PicoWeb 地址不可用');
  return base;
}

async function render() {
  const source = $('source').value;
  const fmt = $('format').value;
  showErrors([]);
  setStatus('渲染中…', null);

  try {
    const base = await getBase();
    const res = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ source, options: [fmt] }),
    });

    const errLines = [];
    const eh = (name) => {
      const v = res.headers.get(name);
      if (v) errLines.push(`${name}: ${v}`);
    };
    eh('x-plantuml-diagram-error');
    eh('x-plantuml-diagram-error-line');

    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (!res.ok) {
      const t = await res.text();
      showErrors([`HTTP ${res.status}`, t.slice(0, 2000)]);
      setStatus('请求失败', false);
      return;
    }

    if (fmt === '-tsvg' || ct.includes('svg')) {
      const svgText = await res.text();
      $('preview-placeholder').classList.add('hidden');
      $('preview-img').classList.add('hidden');
      const wrap = $('preview-svg');
      wrap.innerHTML = svgText;
      wrap.classList.remove('hidden');
    } else {
      const buf = await res.arrayBuffer();
      const blob = new Blob([buf], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const img = $('preview-img');
      const old = img.src;
      if (old.startsWith('blob:')) URL.revokeObjectURL(old);
      img.src = url;
      img.classList.remove('hidden');
      $('preview-placeholder').classList.add('hidden');
      $('preview-svg').classList.add('hidden');
    }

    showErrors(errLines);
    setStatus(errLines.length ? '已渲染（含 PlantUML 报错信息）' : '已渲染', !errLines.length);
  } catch (e) {
    showErrors([String(e.message || e)]);
    setStatus('异常', false);
  }
}

async function exportFile() {
  const source = $('source').value;
  const fmt = $('format').value;
  setStatus('导出中…', null);
  try {
    const base = await getBase();
    const res = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ source, options: [fmt] }),
    });
    if (!res.ok) {
      setStatus(`导出失败 HTTP ${res.status}`, false);
      return;
    }
    const ext = fmt === '-tsvg' ? 'svg' : 'png';
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `diagram.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('已下载', true);
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

function previewHasContent() {
  const ph = $('preview-placeholder');
  if (!ph.classList.contains('hidden')) return false;
  const imgEl = $('preview-img');
  const svgWrap = $('preview-svg');
  return !imgEl.classList.contains('hidden') || !svgWrap.classList.contains('hidden');
}

/** 将当前预览以 PNG 写入系统剪贴板（SVG 预览时按当前源码重新渲染 PNG） */
async function copyPreviewPngToClipboard() {
  if (!window.studio?.copyPngToClipboard || !window.studio?.renderPngToBuffer) {
    setStatus('剪贴板 API 不可用', false);
    return;
  }

  const ph = $('preview-placeholder');
  const imgEl = $('preview-img');
  const svgWrap = $('preview-svg');

  if (!ph.classList.contains('hidden')) {
    setStatus('请先渲染预览', false);
    return;
  }

  try {
    if (!imgEl.classList.contains('hidden') && imgEl.src) {
      const r = await fetch(imgEl.src);
      const buf = await r.arrayBuffer();
      const out = await window.studio.copyPngToClipboard(buf);
      if (!out?.ok) {
        setStatus(out?.error || '复制失败', false);
        return;
      }
      setStatus('已复制 PNG 到剪贴板', true);
      return;
    }

    if (!svgWrap.classList.contains('hidden')) {
      const source = $('source').value;
      const png = await window.studio.renderPngToBuffer(source);
      if (!png?.ok) {
        setStatus(png?.error || '无法从 SVG 模式生成 PNG', false);
        return;
      }
      const out = await window.studio.copyPngToClipboard(png.arrayBuffer);
      if (!out?.ok) {
        setStatus(out?.error || '复制失败', false);
        return;
      }
      setStatus('已复制 PNG 到剪贴板（由当前源码渲染）', true);
      return;
    }

    setStatus('没有可复制的预览', false);
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

function wirePreviewContextMenu() {
  const wrap = $('preview-wrap');
  wrap.addEventListener('contextmenu', (ev) => {
    if (!previewHasContent()) return;
    ev.preventDefault();
    copyPreviewPngToClipboard();
  });
}

async function addCurrentToStash() {
  if (!window.studio?.stashAdd) return;
  const source = $('source').value;
  if (!previewHasContent()) {
    setStatus('请先渲染预览再加入暂存区', false);
    return;
  }
  setStatus('正在写入暂存区…', null);
  try {
    const imgEl = $('preview-img');
    const svgWrap = $('preview-svg');
    let r;
    if (!imgEl.classList.contains('hidden') && imgEl.src) {
      const buf = await (await fetch(imgEl.src)).arrayBuffer();
      r = await window.studio.stashAdd({ kind: 'png', arrayBuffer: buf, sourceText: source });
    } else if (!svgWrap.classList.contains('hidden')) {
      const svgText = svgWrap.innerHTML;
      r = await window.studio.stashAdd({ kind: 'svg', svgText, sourceText: source });
    } else {
      setStatus('没有可暂存的预览', false);
      return;
    }
    if (!r?.ok) {
      setStatus(r?.error || '暂存失败', false);
      return;
    }
    setStatus('已加入暂存区', true);
    await refreshStashList();
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

async function refreshStashList() {
  if (!window.studio?.stashList) return;
  const r = await window.studio.stashList();
  const items = r.items || [];
  $('stash-count').textContent = `${items.length} 项`;
  const grid = $('stash-grid');
  const empty = $('stash-empty');
  if (!items.length) {
    empty.classList.remove('hidden');
    grid.classList.add('hidden');
    grid.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = '';
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'stash-card';
    card.dataset.id = it.id;

    const lab = document.createElement('label');
    lab.className = 'stash-card-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'stash-item-cb';
    cb.setAttribute('aria-label', '选择');
    lab.appendChild(cb);
    card.appendChild(lab);

    const visualEl = document.createElement('div');
    visualEl.className = 'stash-card-visual';
    if (it.previewDataUrl) {
      const im = document.createElement('img');
      im.className = 'stash-thumb';
      im.alt = '';
      im.src = it.previewDataUrl;
      im.addEventListener('click', () => openStashView(it.id));
      visualEl.appendChild(im);
    } else {
      const ph = document.createElement('div');
      ph.className = 'stash-thumb-ph';
      ph.textContent = it.kind === 'svg' ? 'SVG' : 'PNG';
      visualEl.appendChild(ph);
    }
    card.appendChild(visualEl);

    const info = document.createElement('div');
    info.className = 'stash-card-info';
    const labEl = document.createElement('div');
    labEl.className = 'stash-card-label';
    labEl.textContent = it.label || it.id;
    const kindEl = document.createElement('div');
    kindEl.className = 'stash-card-kind';
    kindEl.textContent = `${String(it.kind || '').toUpperCase()}${it.hasPuml ? ' · 含 PlantUML 源码快照' : ''}`;
    info.appendChild(labEl);
    info.appendChild(kindEl);
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'stash-card-actions';
    ['查看', '复制', '删除'].forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t;
      if (i === 0) b.className = 'stash-act-view';
      if (i === 1) b.className = 'stash-act-copy';
      if (i === 2) b.className = 'stash-act-del';
      actions.appendChild(b);
    });
    card.appendChild(actions);

    grid.appendChild(card);
  }
}

async function openStashView(id) {
  if (!window.studio?.stashGetFull) return;
  const r = await window.studio.stashGetFull(id);
  if (!r?.ok) {
    setStatus(r?.error || '无法打开', false);
    return;
  }
  const dlg = $('stash-view-dialog');
  const content = $('stash-dialog-content');
  const title = $('stash-dialog-title');
  title.textContent = r.label || '查看产出';
  content.innerHTML = '';
  if (r.kind === 'png') {
    const im = document.createElement('img');
    im.className = 'stash-dialog-img';
    im.alt = '暂存 PNG';
    im.src = `data:image/png;base64,${r.pngBase64}`;
    content.appendChild(im);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'stash-dialog-svg-wrap';
    wrap.innerHTML = r.svgText;
    content.appendChild(wrap);
  }
  if (typeof dlg.showModal === 'function') dlg.showModal();
}

async function copyStashItem(id) {
  if (!window.studio?.stashCopy) return;
  const r = await window.studio.stashCopy(id);
  if (!r?.ok) {
    setStatus(r?.error || '复制失败', false);
    return;
  }
  setStatus(r.mode === 'svg' ? '已复制 SVG 文本到剪贴板' : '已复制 PNG 图像到剪贴板', true);
}

async function deleteStashItems(ids) {
  if (!ids.length) return;
  if (!window.studio?.stashRemove) return;
  const r = await window.studio.stashRemove(ids);
  if (!r?.ok) {
    setStatus(r?.error || '删除失败', false);
    return;
  }
  setStatus(`已删除 ${ids.length} 条`, true);
  await refreshStashList();
}

function wireStashGrid() {
  const grid = $('stash-grid');
  grid.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const card = ev.target.closest('.stash-card');
    const id = card?.dataset?.id;
    if (!id) return;
    if (btn.classList.contains('stash-act-view')) {
      openStashView(id);
    } else if (btn.classList.contains('stash-act-copy')) {
      copyStashItem(id);
    } else if (btn.classList.contains('stash-act-del')) {
      if (confirm('确定删除该条暂存？')) deleteStashItems([id]);
    }
  });
}

function isAgentKeyConfigured() {
  return Boolean($('cfg-api-key').value?.trim());
}

function agentOrchestrationBlock() {
  return $('agent-orchestration-block');
}

function refreshAgentCompactBarUi() {
  const msg = $('agent-compact-msg');
  const bCollapse = $('btn-agent-collapse');
  const bSet = $('btn-agent-expand-text');
  const bGear = $('btn-agent-expand-gear');
  if (!isAgentKeyConfigured()) {
    msg.textContent = '';
    return;
  }
  const orch = agentOrchestrationBlock();
  const collapsed = orch?.classList.contains('agent-orchestration-block--collapsed');
  if (collapsed) {
    msg.textContent =
      'DeepSeek 已配置。下方「自然语言需求」始终可用；点击「设置」、齿轮或顶部「API 与智能生成」可展开 API 与编排说明区域。';
    bCollapse.classList.add('hidden');
    bSet.classList.remove('hidden');
    bGear.classList.remove('hidden');
    bGear.title = '展开 API 与编排说明';
  } else {
    msg.textContent =
      'API 与编排说明已展开。完成后点击「收起」或再次点击顶部「API 与智能生成」收起该区域（自然语言输入区仍保留）。';
    bCollapse.classList.remove('hidden');
    bSet.classList.add('hidden');
    bGear.classList.add('hidden');
  }
}

/** 无密钥：强制展开编排区块并隐藏紧凑栏；已配置：紧凑栏可见且默认收起编排区块 */
function applyInitialAgentLayoutFromConfig() {
  const bar = $('agent-compact-bar');
  const orch = agentOrchestrationBlock();
  if (!isAgentKeyConfigured()) {
    bar.classList.add('hidden');
    orch?.classList.remove('agent-orchestration-block--collapsed');
    refreshAgentCompactBarUi();
    return;
  }
  bar.classList.remove('hidden');
  orch?.classList.add('agent-orchestration-block--collapsed');
  refreshAgentCompactBarUi();
}

function setAgentMainCollapsed(collapsed) {
  const bar = $('agent-compact-bar');
  const orch = agentOrchestrationBlock();
  if (!isAgentKeyConfigured()) {
    bar.classList.add('hidden');
    orch?.classList.remove('agent-orchestration-block--collapsed');
    refreshAgentCompactBarUi();
    return;
  }
  bar.classList.remove('hidden');
  if (collapsed) orch?.classList.add('agent-orchestration-block--collapsed');
  else orch?.classList.remove('agent-orchestration-block--collapsed');
  refreshAgentCompactBarUi();
}

function toggleAgentMainFromToolbar() {
  if (!isAgentKeyConfigured()) {
    $('agent-compact-bar').classList.add('hidden');
    agentOrchestrationBlock()?.classList.remove('agent-orchestration-block--collapsed');
    refreshAgentCompactBarUi();
    $('cfg-api-key').focus();
    setStatus('请先填写 DeepSeek API Key', null);
    return;
  }
  $('agent-compact-bar').classList.remove('hidden');
  agentOrchestrationBlock()?.classList.toggle('agent-orchestration-block--collapsed');
  refreshAgentCompactBarUi();
}

async function loadAgentForm() {
  if (!window.studio?.getAgentConfig) return;
  try {
    const c = await window.studio.getAgentConfig();
    $('cfg-api-key').value = c.apiKey || '';
    $('cfg-base-url').value = c.baseUrl || '';
    $('cfg-model').value = c.model || '';
    $('cfg-max-retries').value = String(c.maxRetries ?? 3);
    selectedProjectRoot = String(c.lastProjectRoot || '').trim();
    const pr = $('project-root-display');
    if (pr) pr.value = selectedProjectRoot;
    const prev = $('project-summary-preview');
    if (selectedProjectRoot && window.studio?.projectSummary && prev) {
      window.studio
        .projectSummary(selectedProjectRoot)
        .then((r) => {
          if (r?.ok && prev) {
            prev.textContent = r.summary;
            prev.classList.remove('hidden');
          }
        })
        .catch(() => {});
    } else if (prev) {
      prev.textContent = '';
      prev.classList.add('hidden');
    }
    applyInitialAgentLayoutFromConfig();
  } catch {
    /* ignore */
  }
}

async function saveAgentForm() {
  if (!window.studio?.setAgentConfig) return;
  try {
    let hadDiskKey = false;
    if (window.studio?.getAgentConfig) {
      try {
        const disk = await window.studio.getAgentConfig();
        hadDiskKey = Boolean(disk?.apiKey?.trim());
      } catch {
        hadDiskKey = false;
      }
    }
    await window.studio.setAgentConfig({
      apiKey: $('cfg-api-key').value,
      baseUrl: $('cfg-base-url').value,
      model: $('cfg-model').value,
      maxRetries: Number($('cfg-max-retries').value),
    });
    const nowKey = $('cfg-api-key').value.trim();
    const bar = $('agent-compact-bar');
    const orch = agentOrchestrationBlock();
    if (!nowKey) {
      bar.classList.add('hidden');
      orch?.classList.remove('agent-orchestration-block--collapsed');
    } else {
      bar.classList.remove('hidden');
      if (!hadDiskKey && nowKey) {
        orch?.classList.add('agent-orchestration-block--collapsed');
      }
    }
    refreshAgentCompactBarUi();
    setStatus('已保存 API 与编排设置', true);
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

async function applyAgentRunResult(r) {
  const logText = (r.logs || []).join('\n');
  if (logText) setAgentLog(logText, true);
  if (r.source) $('source').value = r.source;
  if (r.ok) {
    setStatus('智能生成成功，正在刷新预览…', true);
    await render();
  } else {
    setStatus(r.error || '智能生成未通过校验', false);
    showErrors([r.error || '未通过 PlantUML 校验', '已将最后一次模型输出填入编辑器，可手动修改后再渲染。']);
    await render();
  }
}

async function runAgent() {
  if (!window.studio?.runAgent) return;
  const userText = $('agent-request').value.trim();
  if (!userText) {
    setStatus('请填写自然语言需求', false);
    return;
  }
  setAgentLog('', false);
  setStatus('DeepSeek 编排运行中…', null);
  try {
    const r = await window.studio.runAgent(userText);
    await applyAgentRunResult(r);
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

async function refreshProjectSummary() {
  if (!window.studio?.projectSummary) return;
  if (!selectedProjectRoot) {
    setStatus('请先选择项目目录', false);
    return;
  }
  setStatus('正在生成本地目录摘要…', null);
  try {
    const r = await window.studio.projectSummary(selectedProjectRoot);
    const prev = $('project-summary-preview');
    if (!r?.ok) {
      setStatus(r?.error || '摘要失败', false);
      return;
    }
    if (prev) {
      prev.textContent = r.summary;
      prev.classList.remove('hidden');
    }
    setStatus(
      `目录摘要已更新（约 ${r.stats?.entries ?? '?'} 条路径，${r.stats?.snippetCount ?? '?'} 段节选）`,
      true
    );
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

async function pickProjectDirectory() {
  if (!window.studio?.pickProjectDirectory) return;
  const r = await window.studio.pickProjectDirectory();
  if (r.canceled) return;
  if (!r?.ok || !r.path) return;
  selectedProjectRoot = r.path;
  const pr = $('project-root-display');
  if (pr) pr.value = r.path;
  if (window.studio.setAgentConfig) {
    await window.studio.setAgentConfig({ lastProjectRoot: r.path });
  }
  await refreshProjectSummary();
}

async function runAgentProjectOneClick() {
  if (!window.studio?.runAgentProject) return;
  const goal = $('agent-request').value.trim();
  if (!goal) {
    setStatus('请填写「自然语言需求」作为制图目标', false);
    return;
  }
  if (!selectedProjectRoot) {
    setStatus('请先选择项目目录', false);
    return;
  }
  setAgentLog('', false);
  setStatus('DeepSeek 结合项目目录分析中…', null);
  try {
    const r = await window.studio.runAgentProject({
      userText: goal,
      projectRoot: selectedProjectRoot,
    });
    await applyAgentRunResult(r);
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

function init() {
  $('source').value = DEFAULT_SOURCE;
  $('btn-render').addEventListener('click', () => render());
  $('btn-export').addEventListener('click', () => exportFile());
  $('format').addEventListener('change', clearPreview);

  $('btn-agent-settings').addEventListener('click', () => toggleAgentMainFromToolbar());

  $('btn-agent-expand-text').addEventListener('click', () => setAgentMainCollapsed(false));
  $('btn-agent-expand-gear').addEventListener('click', () => setAgentMainCollapsed(false));
  $('btn-agent-collapse').addEventListener('click', () => setAgentMainCollapsed(true));

  $('btn-save-agent-cfg').addEventListener('click', () => saveAgentForm());
  $('btn-agent-run').addEventListener('click', () => runAgent());

  $('btn-project-pick')?.addEventListener('click', () => pickProjectDirectory());
  $('btn-project-scan')?.addEventListener('click', () => refreshProjectSummary());
  $('btn-project-generate')?.addEventListener('click', () => runAgentProjectOneClick());

  $('btn-stash-add').addEventListener('click', () => addCurrentToStash());
  $('btn-stash-refresh').addEventListener('click', () => refreshStashList());
  $('btn-stash-select-all').addEventListener('click', () => {
    document.querySelectorAll('.stash-item-cb').forEach((cb) => {
      cb.checked = true;
    });
  });
  $('btn-stash-select-none').addEventListener('click', () => {
    document.querySelectorAll('.stash-item-cb').forEach((cb) => {
      cb.checked = false;
    });
  });
  $('btn-stash-delete-batch').addEventListener('click', async () => {
    const ids = [...document.querySelectorAll('.stash-item-cb:checked')]
      .map((cb) => cb.closest('.stash-card')?.dataset?.id)
      .filter(Boolean);
    if (!ids.length) {
      setStatus('请先勾选要删除的条目', false);
      return;
    }
    if (!confirm(`确定删除选中的 ${ids.length} 条暂存？此操作不可恢复。`)) return;
    await deleteStashItems(ids);
  });
  $('btn-stash-collapse').addEventListener('click', () => {
    const body = $('stash-body');
    const collapsed = body.classList.toggle('hidden');
    $('btn-stash-collapse').textContent = collapsed ? '展开暂存区' : '收起';
  });

  const stashDlg = $('stash-view-dialog');
  $('stash-dialog-close').addEventListener('click', () => stashDlg.close());
  stashDlg.addEventListener('click', (ev) => {
    if (ev.target === stashDlg) stashDlg.close();
  });

  wirePreviewContextMenu();
  wireStashGrid();

  if (window.studio?.onMenuCopyPreview) {
    window.studio.onMenuCopyPreview(() => {
      copyPreviewPngToClipboard();
    });
  }

  loadAgentForm();
  refreshStashList().catch(() => {});

  getBase()
    .then((b) => setStatus(`已连接 ${b}`, true))
    .catch((e) => setStatus(String(e.message || e), false));
}

init();
