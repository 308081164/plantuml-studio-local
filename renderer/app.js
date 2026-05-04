const DEFAULT_SOURCE = `@startuml
title 示例
Alice -> Bob : 本地渲染
Bob --> Alice : OK
@enduml
`;

const CHINA_UNIV_DEFAULT_SOURCE = `@startuml activity
' 关键：@startuml 后面必须加 "activity"，否则会报错!
title 二次方程求根流程图（国内标准写法）
skinparam ActivityShape roundedbox
skinparam ConditionStyle InsideDiamond
skinparam ConditionEndStyle HLine
skinparam activity {
  BorderColor black
  BackgroundColor white
  ArrowColor black
}

:开始;

:输入系数a,b,c的值;

if (|a| <= 10^-6?) then (Y)
  :提示"不是二次方程";
else (N)
  :disc = b^2 - 4ac;
  if (disc <= 10^-6?) then (Y)
    :输出两个相等实根p;
  else (N)
    if (disc > 0?) then (Y)
      :输出两个不等实根p±q;
    else (N)
      :输出两个共轭复根p±qi;
    endif
  endif
endif

:结束;

@enduml
`;

const $ = (id) => document.getElementById(id);

/** 当前选择的项目根目录（与主进程配置 lastProjectRoot 同步） */
let selectedProjectRoot = '';

/** 国内高校模式开关 */
let isChinaUnivMode = false;

/** 最近一轮智能生成 / 项目制图的进程日志（供「文件 → 查看本次执行日志」） */
let lastSessionExecutionLog = '';

function projectIgnoreGlobsValue() {
  const el = $('cfg-project-ignore-globs');
  return el ? el.value : '';
}

function reportErrorArchive(kind, message, detail = '') {
  if (!window.studio?.errorArchiveAppend) return;
  void window.studio.errorArchiveAppend({
    kind: String(kind || 'error').slice(0, 64),
    message: String(message || '').slice(0, 4000),
    detail: String(detail || '').slice(0, 12000),
  });
}

function recordSessionExecutionLog(body) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  lastSessionExecutionLog = `── 最近一轮 · ${ts} ──\n${String(body || '').trim() || '（无日志）'}`;
}

function setStatus(text, ok) {
  const el = $('status');
  el.textContent = text;
  el.classList.remove('status--ok', 'status--error');
  if (ok === true) el.classList.add('status--ok');
  else if (ok === false) el.classList.add('status--error');
}

/**
 * @param {string[]} lines
 * @param {string | null} archiveKind 为 null 时不写入错误归档（仅界面提示）
 */
function showErrors(lines, archiveKind = 'preview-plantuml') {
  const box = $('errors');
  if (!lines.length) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  const joined = lines.join('\n');
  box.textContent = joined;
  box.classList.remove('hidden');
  if (archiveKind) {
    reportErrorArchive(archiveKind, lines[0] || '错误', joined);
  }
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

/**
 * 如果开启国内高校模式，应用相应的转换
 */
function applyChinaUnivModeIfNeeded(source) {
  if (!isChinaUnivMode) return source;
  
  let result = source;
  
  // 1. 把 @startuml 变成 @startuml activity（避免报错 "Cannot find if"）
  if (!result.includes('@startuml activity')) {
    result = result.replace(/@startuml(\s*)/i, '@startuml activity$1');
  }
  
  // 2. 插入必要的 skinparam 配置
  const chinaUnivHeader = `
skinparam ActivityShape roundedbox
skinparam ConditionStyle InsideDiamond
skinparam ConditionEndStyle HLine
skinparam activity {
  BorderColor black
  BackgroundColor white
  ArrowColor black
}
`.trim();
  
  const startMatch = result.match(/(@startuml\s*)/);
  if (startMatch) {
    const startIndex = startMatch.index + startMatch[1].length;
    const before = result.slice(0, startIndex);
    const after = result.slice(startIndex);
    
    if (!after.includes('skinparam ActivityShape roundedbox')) {
      result = `${before}\n${chinaUnivHeader}\n${after}`;
    }
  }
  
  // 3. 安全替换独立的 start/stop
  result = result.replace(/^\s*start\s*$/gm, ':开始;');
  result = result.replace(/^\s*Start\s*$/gm, ':开始;');
  result = result.replace(/^\s*START\s*$/gm, ':开始;');
  result = result.replace(/^\s*stop\s*$/gm, ':结束;');
  result = result.replace(/^\s*Stop\s*$/gm, ':结束;');
  result = result.replace(/^\s*STOP\s*$/gm, ':结束;');
  
  return result;
}

async function render() {
  let source = $('source').value;
  const fmt = $('format').value;
  showErrors([]);
  setStatus('渲染中…', null);

  // 应用国内高校模式转换
  source = applyChinaUnivModeIfNeeded(source);

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
      const errBlock = [`HTTP ${res.status}`, t.slice(0, 2000)];
      showErrors(errBlock, 'render-http');
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
    const msg = String(e.message || e);
    showErrors([msg], 'render-exception');
    setStatus('异常', false);
  }
}

async function exportFile() {
  let source = $('source').value;
  const fmt = $('format').value;
  setStatus('导出中…', null);
  
  // 应用国内高校模式转换
  source = applyChinaUnivModeIfNeeded(source);
  
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
      'DeepSeek 已配置。下方「自然语言需求」始终可用；点击「设置」、齿轮或顶部「API 与智能生成」可展开 API；Shift+点击或双击设置/齿轮可打开「项目忽略」弹窗。执行日志见菜单「文件」。';
    bCollapse.classList.add('hidden');
    bSet.classList.remove('hidden');
    bGear.classList.remove('hidden');
    bGear.title = '展开 API 与编排说明';
  } else {
    msg.textContent =
      'API 与编排说明已展开。完成后点击「收起」或再次点击顶部「API 与智能生成」收起。Shift+点击或双击设置/齿轮打开「项目忽略」。日志见菜单「文件」。';
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
    const ig = $('cfg-project-ignore-globs');
    if (ig) ig.value = c.projectIgnoreGlobs || '';
    selectedProjectRoot = String(c.lastProjectRoot || '').trim();
    const pr = $('project-root-display');
    if (pr) pr.value = selectedProjectRoot;
    // 加载国内高校模式状态
    isChinaUnivMode = Boolean(c.chinaUnivMode);
    const modeCb = $('china-univ-mode');
    if (modeCb) modeCb.checked = isChinaUnivMode;
    // 如果是国内高校模式，并且源码还是默认示例，就换成国内高校的示例
    if (isChinaUnivMode && $('source').value === DEFAULT_SOURCE) {
      $('source').value = CHINA_UNIV_DEFAULT_SOURCE;
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
      projectIgnoreGlobs: projectIgnoreGlobsValue(),
      chinaUnivMode: isChinaUnivMode,
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

function onChinaUnivModeToggle() {
  isChinaUnivMode = $('china-univ-mode').checked;
  // 自动保存配置
  if (window.studio?.setAgentConfig) {
    window.studio.setAgentConfig({ chinaUnivMode: isChinaUnivMode }).catch(() => {});
  }
  // 如果开启国内高校模式，并且当前源码是默认示例，就换成国内高校的示例
  if (isChinaUnivMode && $('source').value === DEFAULT_SOURCE) {
    $('source').value = CHINA_UNIV_DEFAULT_SOURCE;
  }
  setStatus(isChinaUnivMode ? '国内高校模式已开启' : '国内高校模式已关闭', true);
}

async function applyAgentRunResult(r) {
  const logText = (r.logs || []).join('\n');
  recordSessionExecutionLog([logText, r.error && !r.ok ? `错误: ${r.error}` : ''].filter(Boolean).join('\n'));
  if (r.source) $('source').value = r.source;
  if (r.ok) {
    setStatus('智能生成成功，正在刷新预览…', true);
    await render();
  } else {
    setStatus(r.error || '智能生成未通过校验', false);
    showErrors(
      [r.error || '未通过 PlantUML 校验', '已将最后一次模型输出填入编辑器，可手动修改后再渲染。'],
      null
    );
    reportErrorArchive('agent-run', r.error || '智能生成未通过 PlantUML 校验', logText);
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
  setStatus('DeepSeek 编排运行中…', null);
  try {
    const r = await window.studio.runAgent(userText);
    await applyAgentRunResult(r);
  } catch (e) {
    const msg = String(e.message || e);
    setStatus(msg, false);
    reportErrorArchive('agent-exception', msg);
  }
}

function openProjectImportedDialog(absolutePath) {
  const dlg = $('project-imported-dialog');
  $('project-imported-msg').textContent = `已选择项目目录：\n\n${absolutePath}\n\n索引将在「估算上下文」或「一键生成」时在后台构建；主界面不再展示目录摘要。`;
  dlg.showModal();
}

function openAgentAdvancedDialog() {
  const dlg = $('agent-advanced-dialog');
  if (!dlg) return;
  dlg.showModal();
}

function closeAgentAdvancedDialog() {
  $('agent-advanced-dialog')?.close();
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
  openProjectImportedDialog(r.path);
}

async function estimateProjectContext() {
  if (!window.studio?.projectContextEstimate) return;
  if (!selectedProjectRoot) {
    setStatus('请先选择项目目录', false);
    return;
  }
  setStatus('正在估算上下文体积（不调用 DeepSeek）…', null);
  try {
    const r = await window.studio.projectContextEstimate({
      rootPath: selectedProjectRoot,
      userSample: $('agent-request').value.trim(),
      ignoreGlobsText: projectIgnoreGlobsValue(),
    });
    if (!r?.ok) {
      setStatus(r?.error || '估算失败', false);
      reportErrorArchive('estimate-context', r?.error || '估算失败', JSON.stringify(r, null, 2).slice(0, 4000));
      return;
    }
    const warn = r.exceedsProductLimit
      ? ' 已超过产品粗算上限（约 100 万 tokens），正式生成将被拒绝；请缩小目录或增加忽略规则。'
      : '';
    setStatus(
      `粗算首轮约 ${r.estimatedTokens} tokens；可分析文件 ${r.manifestFileEntries} 个、正文聚合 ${r.bundleFileCount} 个；密钥模式已跳过 ${r.skippedSecrets} 条路径。${warn}`,
      !r.exceedsProductLimit
    );
  } catch (e) {
    const msg = String(e.message || e);
    setStatus(msg, false);
    reportErrorArchive('estimate-exception', msg);
  }
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
  setStatus('DeepSeek 规划选文件 + 制图运行中…', null);
  try {
    const r = await window.studio.runAgentProject({
      userText: goal,
      projectRoot: selectedProjectRoot,
      ignoreGlobsText: projectIgnoreGlobsValue(),
    });
    await applyAgentRunResult(r);
  } catch (e) {
    const msg = String(e.message || e);
    setStatus(msg, false);
    reportErrorArchive('agent-project-exception', msg);
  }
}

function openSessionLogDialog() {
  const dlg = $('session-log-dialog');
  const body = $('session-log-dialog-body');
  body.textContent = lastSessionExecutionLog.trim() || '（尚未运行过「智能生成」或「项目一键制图」，或本轮无日志输出）';
  dlg.showModal();
}

async function openErrorLogDialog() {
  const dlg = $('error-log-dialog');
  const body = $('error-log-dialog-body');
  body.textContent = '加载中…';
  dlg.showModal();
  if (!window.studio?.errorArchiveRead) {
    body.textContent = '预加载脚本未暴露 errorArchiveRead';
    return;
  }
  try {
    const r = await window.studio.errorArchiveRead();
    body.textContent = r?.ok ? r.text : r?.error || '读取失败';
  } catch (e) {
    body.textContent = String(e.message || e);
  }
}

function wireAppDialogs() {
  const closeByBackdrop = (id) => {
    const d = $(id);
    if (!d) return;
    d.addEventListener('click', (ev) => {
      if (ev.target === d) d.close();
    });
  };
  closeByBackdrop('agent-advanced-dialog');
  closeByBackdrop('session-log-dialog');
  closeByBackdrop('error-log-dialog');
  closeByBackdrop('project-imported-dialog');

  $('agent-advanced-close-x')?.addEventListener('click', () => closeAgentAdvancedDialog());
  $('agent-advanced-close-btn')?.addEventListener('click', () => closeAgentAdvancedDialog());
  $('btn-agent-advanced-save')?.addEventListener('click', async () => {
    if (window.studio?.setAgentConfig) {
      await window.studio.setAgentConfig({ projectIgnoreGlobs: projectIgnoreGlobsValue() });
      setStatus('已保存项目忽略规则', true);
    }
    closeAgentAdvancedDialog();
  });

  $('session-log-dialog-close')?.addEventListener('click', () => $('session-log-dialog')?.close());
  $('error-log-dialog-close')?.addEventListener('click', () => $('error-log-dialog')?.close());
  $('project-imported-ok')?.addEventListener('click', () => $('project-imported-dialog')?.close());
  $('project-imported-close-x')?.addEventListener('click', () => $('project-imported-dialog')?.close());
}

function wireAgentExpandAdvanced(elId) {
  const el = $(elId);
  if (!el) return;
  el.addEventListener('click', (e) => {
    if (e.shiftKey) {
      e.preventDefault();
      openAgentAdvancedDialog();
      return;
    }
    setAgentMainCollapsed(false);
  });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    openAgentAdvancedDialog();
  });
}

function init() {
  // 国内高校模式开关监听
  $('china-univ-mode')?.addEventListener('change', () => onChinaUnivModeToggle());
  
  // 默认源码加载 - 先加载默认，再在 loadAgentForm 时根据模式替换
  $('source').value = DEFAULT_SOURCE;
  $('btn-render').addEventListener('click', () => render());
  $('btn-export').addEventListener('click', () => exportFile());
  $('format').addEventListener('change', clearPreview);

  $('btn-agent-settings').addEventListener('click', () => toggleAgentMainFromToolbar());

  wireAgentExpandAdvanced('btn-agent-expand-text');
  wireAgentExpandAdvanced('btn-agent-expand-gear');
  $('btn-agent-collapse').addEventListener('click', () => setAgentMainCollapsed(true));

  $('btn-save-agent-cfg').addEventListener('click', () => saveAgentForm());
  $('btn-agent-run').addEventListener('click', () => runAgent());

  $('btn-project-pick')?.addEventListener('click', () => pickProjectDirectory());
  $('btn-project-estimate')?.addEventListener('click', () => estimateProjectContext());
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
  if (window.studio?.onMenuSessionLog) {
    window.studio.onMenuSessionLog(() => openSessionLogDialog());
  }
  if (window.studio?.onMenuErrorLog) {
    window.studio.onMenuErrorLog(() => void openErrorLogDialog());
  }

  wireAppDialogs();
  loadAgentForm();
  refreshStashList().catch(() => {});

  /* ---------- 授权激活 ---------- */
  wireLicenseDialog();

  getBase()
    .then((b) => setStatus(`已连接 ${b}`, true))
    .catch((e) => setStatus(String(e.message || e), false));
}

/* ============================================================
 * 授权激活对话框逻辑
 * ============================================================ */

async function refreshLicenseStatus() {
  if (!window.studio?.licenseGetStatus) return;
  const icon = $('license-status-icon');
  const text = $('license-status-text');
  const deviceArea = $('license-device-area');
  const activateArea = $('license-activate-area');

  try {
    const status = await window.studio.licenseGetStatus();
    if (status.activated) {
      icon.textContent = '✅';
      const mode = status.licenseMode === 'permanent' ? '永久授权' : '限时授权';
      const tier = status.payload?.tier || 'full';
      text.textContent = `已激活（${mode}，等级: ${tier}）`;
      if (status.payload?.valid_until) {
        text.textContent += `，有效期至 ${status.payload.valid_until}`;
      }
      deviceArea.classList.add('hidden');
      activateArea.classList.remove('hidden');
      $('license-code-input').value = '';
      $('license-activate-result').classList.add('hidden');
    } else {
      icon.textContent = '🔒';
      text.textContent = status.error || '未激活';
      deviceArea.classList.remove('hidden');
      activateArea.classList.remove('hidden');
      // 加载设备信息
      await refreshDeviceInfo();
    }
  } catch (e) {
    icon.textContent = '❌';
    text.textContent = `检查授权状态失败: ${e.message}`;
  }
}

async function refreshDeviceInfo() {
  if (!window.studio?.licenseGetDeviceInfo) return;
  try {
    const info = await window.studio.licenseGetDeviceInfo();
    if (info.ok) {
      $('license-hw-id').textContent = info.shortHwId;
      $('license-device-code').textContent = info.deviceCode;
    } else {
      $('license-hw-id').textContent = '获取失败';
      $('license-device-code').textContent = '获取失败';
    }
  } catch (e) {
    $('license-hw-id').textContent = '异常';
    $('license-device-code').textContent = '异常';
  }
}

async function handleLicenseActivate() {
  if (!window.studio?.licenseActivate) return;
  const code = $('license-code-input').value.trim();
  if (!code) {
    setStatus('请输入软件激活码', false);
    return;
  }

  const resultEl = $('license-activate-result');
  resultEl.classList.remove('hidden');
  resultEl.textContent = '正在验证激活码…';
  resultEl.style.color = 'var(--muted)';

  try {
    const r = await window.studio.licenseActivate(code);
    if (r.ok) {
      resultEl.textContent = '✅ 激活成功！';
      resultEl.style.color = 'var(--ok)';
      setStatus('授权激活成功', true);
      await refreshLicenseStatus();
    } else {
      resultEl.textContent = `❌ 激活失败: ${r.error}`;
      resultEl.style.color = 'var(--error)';
      setStatus('激活失败', false);
    }
  } catch (e) {
    resultEl.textContent = `❌ 激活异常: ${e.message}`;
    resultEl.style.color = 'var(--error)';
    setStatus('激活异常', false);
  }
}

async function handleLicenseDeactivate() {
  if (!window.studio?.licenseDeactivate) return;
  if (!confirm('确定卸载激活？卸载后需要重新输入激活码才能使用完整功能。')) return;

  try {
    const r = await window.studio.licenseDeactivate();
    if (r.ok) {
      setStatus('已卸载激活', true);
      await refreshLicenseStatus();
    } else {
      setStatus(`卸载失败: ${r.error}`, false);
    }
  } catch (e) {
    setStatus(`卸载异常: ${e.message}`, false);
  }
}

function wireLicenseDialog() {
  const dlg = $('license-dialog');
  if (!dlg) return;

  // 关闭按钮
  $('license-dialog-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });

  // 复制激活设备码
  $('btn-license-copy-device-code').addEventListener('click', async () => {
    const code = $('license-device-code').textContent;
    if (code && code !== '获取失败') {
      try {
        await navigator.clipboard.writeText(code);
        setStatus('已复制激活设备码', true);
      } catch {
        setStatus('复制失败', false);
      }
    }
  });

  // 激活按钮
  $('btn-license-activate').addEventListener('click', () => handleLicenseActivate());

  // 卸载激活按钮
  $('btn-license-deactivate').addEventListener('click', () => handleLicenseDeactivate());

  // 打开对话框时刷新状态
  dlg.addEventListener('open', () => {
    // dialog 没有 open 事件，用 before-show 模拟
  });

  // 暴露打开方法到全局（供菜单调用）
  window.openLicenseDialog = async () => {
    await refreshLicenseStatus();
    if (typeof dlg.showModal === 'function') dlg.showModal();
  };

  // 在菜单中注册
  if (window.studio?.onMenuLicense) {
    window.studio.onMenuLicense(() => {
      window.openLicenseDialog();
    });
  }
}

init();
