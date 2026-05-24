import { isLockedPlaceholderText } from '../scripts/agent-session-lock.mjs';
import { parseEditorDocument } from '../scripts/diagram-grammar.mjs';

/** Agent 自然语言输入框最大字符数（PlantUML 源码 #source 不设字数上限） */
const AGENT_REQUEST_MAX_CHARS = 3000;

const DEFAULT_SOURCE = `@startuml
title 示例
Alice -> Bob : 本地渲染
Bob --> Alice : OK
@enduml
`;

const CHEN_ER_DEFAULT_SOURCE = `@startchen "学生选课系统 ER 图（陈氏表示法）"
left to right direction

skinparam defaultFontSize 24

<style>
chenEntity {
  BackGroundColor white
  BorderColor black
  FontSize 24
}
chenRelationship {
  BackGroundColor white
  BorderColor black
  FontSize 24
}
</style>

entity "学生" as Student { }
entity "课程" as Course { }
entity "教师" as Teacher { }

relationship "选修" as Enroll { }
relationship "讲授" as Teach { }

Student -N- Enroll
Enroll -N- Course

Teacher -1- Teach
Teach -N- Course
@endchen
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

:开始; <<task>>

:输入系数a,b,c的值; <<save>>

if (|a| <= 10^-6?) then (Y)
  :提示"不是二次方程"; <<save>>
else (N)
  :disc = b^2 - 4ac; <<task>>
  if (disc <= 10^-6?) then (Y)
    :输出两个相等实根p; <<save>>
  else (N)
    if (disc > 0?) then (Y)
      :输出两个不等实根p±q; <<save>>
    else (N)
      :输出两个共轭复根p±qi; <<save>>
    endif
  endif
endif

:结束; <<task>>

@enduml
`;

const $ = (id) => document.getElementById(id);

/** 当前选择的项目根目录（与主进程配置 lastProjectRoot 同步） */
let selectedProjectRoot = '';

function normalizeProjectRoot(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

/** 顶栏项目路径为 span，必须使用 textContent 回显（误用 .value 会导致选择目录后不显示） */
function syncProjectRootDisplay(absolutePath) {
  const el = $('project-root-display');
  if (!el) return;
  const p =
    absolutePath !== undefined && absolutePath !== null
      ? String(absolutePath).trim()
      : String(selectedProjectRoot || '').trim();
  el.textContent = p || '未选择项目目录…';
  el.title = p || '';
  el.classList.toggle('project-path--set', Boolean(p));
}

/** 国内高校模式开关 */
let isChinaUnivMode = false;

/** 最近一轮智能生成 / 项目制图的进程日志（供「文件 → 查看本次执行日志」） */
let lastSessionExecutionLog = '';

/** 暂存区文件夹数据 */
let stashFolders = [];

/** 单次支付确认弹窗 Promise 收尾（由 wirePayUnlockConfirmDialog 注册） */
let payUnlockConfirmResolver = null;

/** 国内高校模式开启确认（避免 Electron 原生 confirm 夺走焦点导致输入框无法再键入） */
let chinaUnivConfirmResolver = null;
/** @type {boolean} */
let chinaUnivConfirmChoice = false;

/** 免费版主页免费用量轻量定时刷新（避免仅打开授权页时才看到计数变化） */
let freeQuotaPollTimerId = null;

/** SVG 编辑器实例 */
let svgEditor = null;

/** 是否处于画板编辑模式 */
let isInEditMode = false;

let studioBusyDepth = 0;

function beginStudioBusy(message) {
  studioBusyDepth += 1;
  const overlay = $('studio-busy-overlay');
  const msg = $('studio-busy-message');
  if (msg) msg.textContent = message || '正在处理…';
  overlay?.classList.remove('hidden');
}

function endStudioBusy() {
  studioBusyDepth = Math.max(0, studioBusyDepth - 1);
  if (studioBusyDepth === 0) {
    $('studio-busy-overlay')?.classList.add('hidden');
  }
}

let studioToastTimer = null;

function showToast(message, variant = 'info', duration = 4000) {
  const el = $('studio-toast');
  if (!el) return;
  clearTimeout(studioToastTimer);
  const v = variant === 'success' || variant === 'error' ? variant : 'info';
  el.textContent = String(message || '');
  el.className = `studio-toast studio-toast--${v}`;
  requestAnimationFrame(() => {
    el.classList.add('studio-toast--visible');
  });
  studioToastTimer = setTimeout(() => {
    el.classList.remove('studio-toast--visible');
  }, duration);
}

let projectSwitchResolver = null;
let projectSwitchSettled = false;

function wireProjectSwitchDialogOnce() {
  const dlg = $('project-switch-dialog');
  if (!dlg || dlg.dataset.wired === '1') return;
  dlg.dataset.wired = '1';
  const finish = (payload) => {
    if (projectSwitchSettled) return;
    projectSwitchSettled = true;
    const fn = projectSwitchResolver;
    projectSwitchResolver = null;
    if (typeof fn === 'function') fn(payload);
    if (dlg.open) dlg.close();
  };
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish({ kind: 'new' });
  });
  $('project-switch-resume')?.addEventListener('click', () => {
    const sel = $('project-switch-conv-select');
    const id = sel?.value;
    if (!id) return;
    finish({ kind: 'resume', conversationId: id });
  });
  $('project-switch-new')?.addEventListener('click', () => finish({ kind: 'new' }));
  $('project-switch-close')?.addEventListener('click', () => finish({ kind: 'new' }));
}

/**
 * @param {{ pickedPath: string, previousLabel: string, matches: Array<object> }} opts
 * @returns {Promise<{ kind: 'new' } | { kind: 'resume', conversationId: string }>}
 */
function openProjectSwitchDialog(opts) {
  const pickedPath = String(opts?.pickedPath || '').trim();
  const previousLabel = String(opts?.previousLabel ?? '');
  const matches = Array.isArray(opts?.matches) ? opts.matches : [];
  return new Promise((resolve) => {
    wireProjectSwitchDialogOnce();
    projectSwitchSettled = false;
    projectSwitchResolver = resolve;
    const dlg = $('project-switch-dialog');
    const lead = $('project-switch-lead');
    const wrap = $('project-switch-match-wrap');
    const noM = $('project-switch-no-match');
    const btnResume = $('project-switch-resume');
    const sel = $('project-switch-conv-select');
    if (!dlg || !lead || !wrap || !noM || !btnResume || !sel) {
      resolve({ kind: 'new' });
      return;
    }
    lead.textContent = `新的项目目录：\n${pickedPath}\n\n此前顶栏为：${previousLabel || '（未选择）'}\n\n为避免多轮上下文与错误仓库混杂，请选择：恢复该目录下的历史对话，或新建一条对话并绑定新路径。`;
    sel.innerHTML = '';
    if (matches.length) {
      wrap.classList.remove('hidden');
      noM.classList.add('hidden');
      btnResume.classList.remove('hidden');
      for (const c of matches) {
        const opt = document.createElement('option');
        opt.value = c.id;
        const title = String(c.title || '').trim() || c.id.slice(0, 8);
        const t = c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '';
        opt.textContent = t ? `${title} · ${t}` : title;
        sel.appendChild(opt);
      }
    } else {
      wrap.classList.add('hidden');
      btnResume.classList.add('hidden');
      noM.classList.remove('hidden');
      noM.textContent =
        '该目录下尚无已保存的对话记录。将新建一条对话并绑定此路径（可在「对话」下拉里切换其它会话）。';
    }
    dlg.showModal();
  });
}

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

let pendingPayOrderId = '';

/** 本地持久化的智能 PlantUML 对话（多轮） */
let agentConversationsState = { activeId: null, conversations: [] };

function newAgentChatId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getActiveAgentConversation() {
  const id = agentConversationsState.activeId;
  if (!id) return null;
  return agentConversationsState.conversations.find((c) => c.id === id) || null;
}

function ensureActiveAgentConversation() {
  if (!agentConversationsState.conversations.length) {
    const id = newAgentChatId();
    agentConversationsState.conversations.push({
      id,
      title: '新对话',
      updatedAt: Date.now(),
      projectRoot: '',
      messages: [],
    });
    agentConversationsState.activeId = id;
    return;
  }
  if (
    !agentConversationsState.activeId ||
    !agentConversationsState.conversations.some((c) => c.id === agentConversationsState.activeId)
  ) {
    agentConversationsState.activeId = agentConversationsState.conversations[0].id;
  }
}

function renderAgentChatSelectUi() {
  const sel = $('agent-chat-select');
  if (!sel) return;
  sel.innerHTML = '';
  const list = [...agentConversationsState.conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const c of list) {
    const opt = document.createElement('option');
    opt.value = c.id;
    const t = String(c.title || '').trim() || c.id.slice(0, 8);
    opt.textContent = t;
    sel.appendChild(opt);
  }
  if (agentConversationsState.activeId) sel.value = agentConversationsState.activeId;
}

async function persistAgentConversations() {
  if (!window.studio?.agentConversationsSave) return;
  await window.studio.agentConversationsSave(agentConversationsState);
}

async function loadAgentConversationsFromDisk() {
  if (!window.studio?.agentConversationsLoad) return;
  const r = await window.studio.agentConversationsLoad();
  const st = r?.state;
  if (r?.ok === false) {
    agentConversationsState = { activeId: null, conversations: [] };
    ensureActiveAgentConversation();
    renderAgentChatSelectUi();
    return;
  }
  if (!st || !Array.isArray(st.conversations)) {
    agentConversationsState = { activeId: null, conversations: [] };
  } else {
    agentConversationsState = {
      activeId: typeof st.activeId === 'string' ? st.activeId : null,
      conversations: st.conversations,
    };
  }
  for (const c of agentConversationsState.conversations) {
    if (c.projectRoot == null) c.projectRoot = '';
  }
  ensureActiveAgentConversation();
  renderAgentChatSelectUi();
}

async function createNewAgentConversation() {
  const id = newAgentChatId();
  agentConversationsState.conversations.unshift({
    id,
    title: '新对话',
    updatedAt: Date.now(),
    projectRoot: normalizeProjectRoot(selectedProjectRoot),
    messages: [],
  });
  agentConversationsState.activeId = id;
  const ta = $('agent-request');
  if (ta) ta.value = '';
  syncAgentRequestCounter();
  renderAgentChatSelectUi();
  await persistAgentConversations();
  setStatus('已新建对话（多轮上下文已重置）', true);
}

async function deleteActiveAgentConversation() {
  const id = agentConversationsState.activeId;
  if (!id) return;
  agentConversationsState.conversations = agentConversationsState.conversations.filter((c) => c.id !== id);
  agentConversationsState.activeId = null;
  ensureActiveAgentConversation();
  const ta = $('agent-request');
  if (ta) ta.value = '';
  syncAgentRequestCounter();
  renderAgentChatSelectUi();
  await persistAgentConversations();
  setStatus('已删除对话', true);
}

function onAgentChatSelectChange() {
  const sel = $('agent-chat-select');
  if (!sel) return;
  const id = sel.value;
  if (!id) return;
  agentConversationsState.activeId = id;
  const c = getActiveAgentConversation();
  const bind = normalizeProjectRoot(c?.projectRoot || '');
  void (async () => {
    if (bind && bind !== normalizeProjectRoot(selectedProjectRoot)) {
      selectedProjectRoot = String(c.projectRoot || '').trim();
      syncProjectRootDisplay(selectedProjectRoot);
      if (window.studio?.setAgentConfig) {
        await window.studio.setAgentConfig({ lastProjectRoot: selectedProjectRoot });
      }
      showToast('已随对话切换到其绑定的项目目录', 'success');
    }
    const ta = $('agent-request');
    if (ta) ta.value = '';
    syncAgentRequestCounter();
    await persistAgentConversations();
    setStatus('已切换对话（需求输入框已清空；源码区未改动）', true);
  })();
}

function getActiveConversationHistoryForApi() {
  const c = getActiveAgentConversation();
  if (!c || !Array.isArray(c.messages)) return [];
  return c.messages.map((m) => ({ role: m.role, content: String(m.content || '') }));
}

async function appendSuccessfulAgentTurn(userText, assistantPlantumlSource) {
  const c = getActiveAgentConversation();
  if (!c) return;
  const ut = String(userText || '').trim();
  const as = String(assistantPlantumlSource || '').trim();
  if (!ut || !as) return;
  if (!normalizeProjectRoot(c.projectRoot) && normalizeProjectRoot(selectedProjectRoot)) {
    c.projectRoot = normalizeProjectRoot(selectedProjectRoot);
  }
  c.messages.push({ role: 'user', content: ut });
  c.messages.push({ role: 'assistant', content: as });
  c.updatedAt = Date.now();
  if (!c.title || c.title === '新对话' || c.title.length < 2) {
    c.title = ut.length > 40 ? `${ut.slice(0, 40)}…` : ut;
  }
  renderAgentChatSelectUi();
  await persistAgentConversations();
}

async function getEffectivePlantumlBundle() {
  if (window.studio?.getEffectivePlantumlSource) {
    const r = await window.studio.getEffectivePlantumlSource({ editorText: $('source').value });
    if (r?.ok) return { source: r.source, locked: Boolean(r.locked) };
  }
  return { source: $('source').value, locked: false };
}

async function isUiAgentLocked() {
  if (!window.studio?.agentLockGet) return false;
  try {
    const r = await window.studio.agentLockGet();
    return Boolean(r?.active);
  } catch {
    return false;
  }
}

function setPreviewLockOverlay(show) {
  const el = $('preview-free-overlay');
  if (!el) return;
  el.classList.toggle('hidden', !show);
}

function updatePayUnlockButtonsVisible(locked) {
  ['btn-pay-mock-local', 'btn-pay-unlock', 'btn-pay-done'].forEach((id) => {
    const b = $(id);
    if (!b) return;
    if (locked) b.classList.remove('hidden');
    else b.classList.add('hidden');
  });
}

async function applyUnlockedSource(r, statusMsg) {
  pendingPayOrderId = '';
  $('source').value = r.source || '';
  $('source').readOnly = false;
  document.body.classList.remove('studio-agent-source-locked');
  setPreviewLockOverlay(false);
  updatePayUnlockButtonsVisible(false);
  setStatus(statusMsg || '已恢复源码与导出能力', true);
  await render();
}

async function runLocalMockPaySuccess() {
  if (!window.studio?.payLocalMockComplete) return;
  const r = await window.studio.payLocalMockComplete();
  if (!r?.ok) {
    setStatus(r?.error || '本地模拟解锁失败', false);
    return;
  }
  await applyUnlockedSource(r, '本地模拟：已解除锁定，可正常导出与暂存');
}

function wirePayUnlockConfirmDialog() {
  const dlg = $('pay-unlock-confirm-dialog');
  if (!dlg || dlg.dataset.wired === '1') return;
  dlg.dataset.wired = '1';
  let userChosePay = false;

  $('pay-unlock-confirm-go')?.addEventListener('click', () => {
    userChosePay = true;
    dlg.close();
  });
  $('pay-unlock-confirm-cancel')?.addEventListener('click', () => {
    userChosePay = false;
    dlg.close();
  });
  $('pay-unlock-confirm-close')?.addEventListener('click', () => {
    userChosePay = false;
    dlg.close();
  });

  dlg.addEventListener('close', () => {
    const fn = payUnlockConfirmResolver;
    payUnlockConfirmResolver = null;
    const agreed = userChosePay;
    userChosePay = false;
    fn?.(agreed);
  });
}

function openPayUnlockConfirmDialog() {
  const dlg = $('pay-unlock-confirm-dialog');
  if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    payUnlockConfirmResolver = resolve;
    dlg.showModal();
  });
}

/** 原生 window.confirm / 异步 IPC 后主进程焦点未回到 Renderer 时，Agent 文本框会失去键盘输入；双 rAF + 主进程收回焦点可避免此现象 */
async function restoreAgentNlFocus() {
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
  try {
    if (typeof window.studio?.focusMainRenderer === 'function') {
      await window.studio.focusMainRenderer();
    }
  } catch {
    /* ignore */
  }
  const wrap = $('agent-nl-wrap');
  const ta = $('agent-request');
  const panelOpen = wrap && !wrap.classList.contains('hidden');
  if (panelOpen && ta) {
    try {
      ta.focus({ preventScroll: true });
    } catch {
      ta.focus();
    }
  } else {
    try {
      $('china-univ-mode')?.focus({ preventScroll: true });
    } catch {
      $('china-univ-mode')?.focus();
    }
  }
}

function wireChinaUnivConfirmDialog() {
  const dlg = $('china-univ-confirm-dialog');
  if (!dlg || dlg.dataset.wired === '1') return;
  dlg.dataset.wired = '1';
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) {
      chinaUnivConfirmChoice = false;
      dlg.close();
    }
  });
  dlg.addEventListener('close', () => {
    const fn = chinaUnivConfirmResolver;
    chinaUnivConfirmResolver = null;
    fn?.(chinaUnivConfirmChoice);
    chinaUnivConfirmChoice = false;
  });
  $('china-univ-confirm-accept')?.addEventListener('click', () => {
    chinaUnivConfirmChoice = true;
    dlg.close();
  });
  $('china-univ-confirm-cancel')?.addEventListener('click', () => {
    chinaUnivConfirmChoice = false;
    dlg.close();
  });
  $('china-univ-confirm-close')?.addEventListener('click', () => {
    chinaUnivConfirmChoice = false;
    dlg.close();
  });
}

function openChinaUnivConfirmDialog() {
  const dlg = $('china-univ-confirm-dialog');
  if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    chinaUnivConfirmChoice = false;
    chinaUnivConfirmResolver = resolve;
    dlg.showModal();
  });
}

async function beginPayUnlockFlow() {
  const go = await openPayUnlockConfirmDialog();
  if (!go) return;

  if (!window.studio?.payOrderCreate) return;
  const cr = await window.studio.payOrderCreate();
  if (!cr?.ok) {
    setStatus(cr?.error || '创建支付订单失败', false);
    return;
  }
  pendingPayOrderId = cr.orderId || '';
  if (cr.payUrl && window.studio.payOpenExternal) {
    const openR = await window.studio.payOpenExternal(cr.payUrl);
    if (openR && openR.ok === false) {
      setStatus(openR.error || '无法打开浏览器', false);
      return;
    }
    setStatus('若已打开支付页，完成支付后请点击「我已完成支付」', null);
  } else {
    setStatus('未返回支付链接（可能未启动支付服务）。可点击「本地模拟支付成功」临时解锁。', null);
  }
}

async function confirmPayCompleted() {
  if (!window.studio?.payPollStatus || !window.studio?.payRedeemUnlock) return;
  const id = pendingPayOrderId;
  if (!id) {
    setStatus('请先点击「支付解锁本条」生成订单', false);
    return;
  }
  const st = await window.studio.payPollStatus(id);
  if (!st?.ok) {
    setStatus(st?.error || '查询订单失败', false);
    return;
  }
  if (st.status !== 'paid' || !st.unlockToken) {
    setStatus('尚未检测到支付成功，请稍后再试或检查网络', false);
    return;
  }
  const r = await window.studio.payRedeemUnlock(st.unlockToken);
  if (!r?.ok) {
    setStatus(r?.error || '解锁失败', false);
    return;
  }
  await applyUnlockedSource(r, '支付校验成功，已恢复源码与导出能力');
}

function recordSessionExecutionLog(body) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  lastSessionExecutionLog = `── 最近一轮 · ${ts} ──\n${String(body || '').trim() || '（无日志）'}`;
}

function setStatus(text, ok) {
  const el = $('status');
  if (!el) return;
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
  if (!box) return;
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
  const ph = $('preview-placeholder');
  const img = $('preview-img');
  const svg = $('preview-svg');
  if (ph) {
    ph.classList.remove('hidden');
  }
  if (img) {
    img.classList.add('hidden');
    img.removeAttribute('src');
  }
  if (svg) {
    svg.classList.add('hidden');
    svg.innerHTML = '';
  }
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
 * 注意：@startchen 语法不需要转换，保持原样
 */
function applyChinaUnivModeIfNeeded(source) {
  if (!isChinaUnivMode) return source;

  if (source.includes('@startchen') || /@startwbs\b/i.test(source)) {
    return source;
  }
  
  let result = source;
  
  if (!result.includes('@startuml activity')) {
    result = result.replace(/@startuml(\s*)/i, '@startuml activity$1');
  }
  
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
  
  result = result.replace(/^\s*start\s*$/gm, ':开始;');
  result = result.replace(/^\s*Start\s*$/gm, ':开始;');
  result = result.replace(/^\s*START\s*$/gm, ':开始;');
  result = result.replace(/^\s*stop\s*$/gm, ':结束;');
  result = result.replace(/^\s*Stop\s*$/gm, ':结束;');
  result = result.replace(/^\s*STOP\s*$/gm, ':结束;');
  
  return result;
}

async function render() {
  const bundle = await getEffectivePlantumlBundle();
  const grammarText = bundle.locked ? bundle.source : $('source').value;
  const doc = parseEditorDocument(grammarText);

  const fmtEl = $('format');
  if (!fmtEl) {
    setStatus('界面未就绪（缺少格式选择控件）', false);
    return;
  }
  const fmt = fmtEl.value;
  showErrors([]);
  setStatus('渲染中…', null);
  setPreviewLockOverlay(Boolean(bundle.locked));

  if (doc.kind === 'studio-arch') {
    if (!window.studio?.archRender) {
      setStatus('当前版本不支持静态架构渲染', false);
      return;
    }
    if (!selectedProjectRoot) {
      showErrors(['请先选择「项目代码目录」，以便扫描仓库内静态 import 依赖。'], 'arch-no-root');
      setStatus('未选择项目目录', false);
      clearPreview();
      return;
    }
    try {
      const ar = await window.studio.archRender({
        projectRoot: selectedProjectRoot,
        ignoreGlobsText: projectIgnoreGlobsValue(),
        archBlock: doc.archBlock,
      });
      if (!ar?.ok) {
        showErrors([ar?.error || '架构图渲染失败'], 'arch-render');
        setStatus('渲染失败', false);
        clearPreview();
        return;
      }
      $('preview-placeholder').classList.add('hidden');
      $('preview-img').classList.add('hidden');
      const wrap = $('preview-svg');
      wrap.innerHTML = ar.svgText || '';
      wrap.classList.remove('hidden');
      showErrors([]);
      const meta = ar.meta || {};
      setStatus(
        `已渲染静态架构 SVG（约 ${meta.nodes ?? '?'} 节点 / ${meta.edges ?? '?'} 条边 / 扫描 ${meta.files ?? '?'} 个源码文件）`,
        true
      );
    } catch (e) {
      const msg = String(e.message || e);
      showErrors([msg], 'arch-exception');
      setStatus('异常', false);
    }
    return;
  }

  let source = bundle.source;
  source = applyChinaUnivModeIfNeeded(source);

  try {
    const base = await getBase();
    const res = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ source, options: [fmt] }),
    });

    const diagErr = (res.headers.get('x-plantuml-diagram-error') || '').trim();
    const diagLine = res.headers.get('x-plantuml-diagram-error-line');
    const errLines = [];
    if (diagErr) errLines.push(`x-plantuml-diagram-error: ${diagErr}`);
    if (diagLine) errLines.push(`x-plantuml-diagram-error-line: ${diagLine}`);

    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (!res.ok) {
      const t = await res.text();
      const errBlock = [`HTTP ${res.status}`, t.slice(0, 2000)];
      showErrors(errBlock, 'render-http');
      setStatus('请求失败', false);
      return;
    }

    if (diagErr) {
      if (fmt === '-tsvg' || ct.includes('svg')) await res.text();
      else await res.arrayBuffer();
      clearPreview();
      showErrors(
        errLines.length
          ? errLines
          : ['PlantUML 报告了语法或图形错误；已隐藏错误占位图（其中可能含有推广链接）。'],
        'preview-plantuml'
      );
      setStatus('渲染失败：请根据上方文本信息修正源码', false);
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
    setStatus(errLines.length ? '已渲染（含响应头提示）' : '已渲染', !errLines.length);
  } catch (e) {
    const raw = String(e?.message || e);
    let msg = raw;
    if (/fetch failed|failed to fetch|networkerror/i.test(raw)) {
      msg = `${raw}\n\n提示：本机预览依赖 Java PlantUML PicoWeb（127.0.0.1）。若持续失败，请确认本机已安装 Java、安装包内含 plantuml-*.jar，且安全软件未拦截本地回环。`;
    }
    clearPreview();
    showErrors([msg], 'render-exception');
    setStatus('异常', false);
  }
}

async function exportFile() {
  if (await isUiAgentLocked()) {
    setStatus('免费版：智能生成锁定状态下无法导出，请先支付解锁或激活专业版。', false);
    return;
  }
  const bundle = await getEffectivePlantumlBundle();
  const grammarText = bundle.locked ? bundle.source : $('source').value;
  const doc = parseEditorDocument(grammarText);

  if (doc.kind === 'studio-arch') {
    if (!selectedProjectRoot) {
      setStatus('请先选择项目目录', false);
      return;
    }
    if (!window.studio?.archRender) {
      setStatus('架构导出不可用', false);
      return;
    }
    setStatus('导出静态架构 SVG…', null);
    try {
      const ar = await window.studio.archRender({
        projectRoot: selectedProjectRoot,
        ignoreGlobsText: projectIgnoreGlobsValue(),
        archBlock: doc.archBlock,
      });
      if (!ar?.ok) {
        setStatus(ar?.error || '导出失败', false);
        return;
      }
      const blob = new Blob([ar.svgText || ''], { type: 'image/svg+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'studio-arch.svg';
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus('已下载 studio-arch.svg', true);
    } catch (e) {
      setStatus(String(e.message || e), false);
    }
    return;
  }

  let source = bundle.source;
  const fmtEl = $('format');
  if (!fmtEl) {
    setStatus('界面未就绪（缺少格式选择控件）', false);
    return;
  }
  const fmt = fmtEl.value;
  setStatus('导出中…', null);

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
    const diagErr = (res.headers.get('x-plantuml-diagram-error') || '').trim();
    if (diagErr) {
      if (fmt === '-tsvg' || (res.headers.get('content-type') || '').toLowerCase().includes('svg')) {
        await res.text();
      } else {
        await res.arrayBuffer();
      }
      setStatus('PlantUML 报错，已取消导出（避免下载含推广信息的错误图）', false);
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
  if (!ph || !ph.classList.contains('hidden')) return false;
  const imgEl = $('preview-img');
  const svgWrap = $('preview-svg');
  return imgEl && svgWrap && (!imgEl.classList.contains('hidden') || !svgWrap.classList.contains('hidden'));
}

/** 将当前预览以 PNG 写入系统剪贴板（SVG 预览时按当前源码重新渲染 PNG） */
async function copyPreviewPngToClipboard() {
  if (await isUiAgentLocked()) {
    setStatus('免费版：锁定状态下无法复制预览图', false);
    return;
  }
  if (!window.studio?.copyPngToClipboard || !window.studio?.renderPngToBuffer) {
    setStatus('剪贴板 API 不可用', false);
    return;
  }

  const ph = $('preview-placeholder');
  const imgEl = $('preview-img');
  const svgWrap = $('preview-svg');

  if (!ph || !imgEl || !svgWrap) {
    setStatus('预览区控件缺失', false);
    return;
  }

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
      const bundle = await getEffectivePlantumlBundle();
      const grammarText = bundle.locked ? bundle.source : $('source').value;
      const doc = parseEditorDocument(grammarText);
      if (doc.kind === 'studio-arch') {
        setStatus('静态架构图为 SVG：请使用「导出」下载，或从预览区复制 SVG 源码（暂不支持转 PNG 剪贴板）', false);
        return;
      }
      const source = bundle.source;
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
  if (!wrap) return;
  wrap.addEventListener('contextmenu', (ev) => {
    if (!previewHasContent()) return;
    ev.preventDefault();
    copyPreviewPngToClipboard();
  });
}

async function openStashAddDialog() {
  if (await isUiAgentLocked()) {
    setStatus('免费版：智能生成锁定状态下无法加入暂存区', false);
    return;
  }
  const dlg = $('stash-add-dialog');
  const nameInput = $('stash-add-name');
  const folderSelect = $('stash-add-folder');

  nameInput.value = '';
  folderSelect.innerHTML = '<option value="">暂存区根目录</option>';

  stashFolders.forEach(folder => {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.name;
    folderSelect.appendChild(option);
  });

  dlg.showModal();
  requestAnimationFrame(() => {
    nameInput.focus();
  });
}

async function addCurrentToStashWithFolder() {
  const dlg = $('stash-add-dialog');
  const name = $('stash-add-name').value.trim();
  const folderId = $('stash-add-folder').value;
  
  dlg.close();
  
  if (!previewHasContent()) {
    setStatus('请先渲染预览再加入暂存区', false);
    return;
  }
  
  setStatus('正在写入暂存区…', null);
  
  try {
    const source = $('source').value;
    const imgEl = $('preview-img');
    const svgWrap = $('preview-svg');
    let r;
    
    if (!imgEl.classList.contains('hidden') && imgEl.src) {
      const buf = await (await fetch(imgEl.src)).arrayBuffer();
      r = await window.studio.stashAdd({ 
        kind: 'png', 
        arrayBuffer: buf, 
        sourceText: source,
        label: name || undefined,
        folderId: folderId || undefined
      });
    } else if (!svgWrap.classList.contains('hidden')) {
      const svgText = svgWrap.innerHTML;
      r = await window.studio.stashAdd({ 
        kind: 'svg', 
        svgText, 
        sourceText: source,
        label: name || undefined,
        folderId: folderId || undefined
      });
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
  if (!r?.ok) {
    stashFolders = [];
    const items = [];
    $('stash-count').textContent = '0 项';
    const tree = $('stash-tree');
    const empty = $('stash-empty');
    empty.classList.remove('hidden');
    tree.classList.add('hidden');
    tree.innerHTML = '';
    return;
  }
  const items = r.items || [];
  stashFolders = r.folders || [];
  
  $('stash-count').textContent = `${items.length} 项`;
  const tree = $('stash-tree');
  const empty = $('stash-empty');
  
  if (!items.length && !stashFolders.length) {
    empty.classList.remove('hidden');
    tree.classList.add('hidden');
    tree.innerHTML = '';
    return;
  }
  
  empty.classList.add('hidden');
  tree.classList.remove('hidden');
  tree.innerHTML = '';
  
  stashFolders.forEach(folder => {
    const folderEl = document.createElement('div');
    folderEl.className = 'stash-folder';
    folderEl.dataset.id = folder.id;
    
    const icon = document.createElement('svg');
    icon.className = 'stash-folder-icon';
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.innerHTML = '<path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>';
    
    const name = document.createElement('span');
    name.className = 'stash-folder-name';
    name.textContent = folder.name;
    
    const count = document.createElement('span');
    count.className = 'stash-folder-count';
    const folderItems = items.filter(i => i.folderId === folder.id);
    count.textContent = `${folderItems.length} 项`;
    
    folderEl.appendChild(icon);
    folderEl.appendChild(name);
    folderEl.appendChild(count);
    
    folderEl.addEventListener('click', () => {
      showStashFolderContent(folder.id);
    });
    
    tree.appendChild(folderEl);
  });
  
  const grid = document.createElement('div');
  grid.className = 'stash-grid';
  
  const rootItems = items.filter(i => !i.folderId);
  
  rootItems.forEach(it => {
    grid.appendChild(createStashCard(it));
  });
  
  tree.appendChild(grid);
}

function createStashCard(it) {
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
  ['查看', '复制源码', '删除'].forEach((t, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    if (i === 0) b.className = 'stash-act-view';
    if (i === 1) b.className = 'stash-act-copy';
    if (i === 2) b.className = 'stash-act-del';
    actions.appendChild(b);
  });
  card.appendChild(actions);

  return card;
}

function showStashFolderContent(folderId) {
  const tree = $('stash-tree');
  tree.innerHTML = '';
  
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = '← 返回根目录';
  backBtn.addEventListener('click', () => refreshStashList());
  tree.appendChild(backBtn);
  
  const grid = document.createElement('div');
  grid.className = 'stash-grid';
  
  if (!window.studio?.stashList) return;
  
  window.studio.stashList().then(r => {
    const items = (r.items || []).filter(i => i.folderId === folderId);
    items.forEach(it => {
      grid.appendChild(createStashCard(it));
    });
    tree.appendChild(grid);
  });
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
  
  if (r.sourceText) {
    const sourceLabel = document.createElement('div');
    sourceLabel.style.marginTop = '1rem';
    sourceLabel.style.fontSize = '0.75rem';
    sourceLabel.style.color = 'var(--muted)';
    sourceLabel.textContent = 'PlantUML 源码：';
    content.appendChild(sourceLabel);
    
    const sourcePre = document.createElement('pre');
    sourcePre.style.margin = '0.5rem 0';
    sourcePre.style.padding = '0.5rem';
    sourcePre.style.background = 'var(--editor-bg)';
    sourcePre.style.borderRadius = '6px';
    sourcePre.style.fontSize = '0.75rem';
    sourcePre.style.maxHeight = '300px';
    sourcePre.style.overflow = 'auto';
    sourcePre.textContent = r.sourceText;
    content.appendChild(sourcePre);
  }
  
  if (typeof dlg.showModal === 'function') dlg.showModal();
}

function toggleEditMode() {
  const svgWrap = $('preview-svg');
  const imgEl = $('preview-img');

  if (isInEditMode) {
    exitEditMode();
  } else {
    if (!svgWrap.classList.contains('hidden') && svgWrap.querySelector('svg')) {
      enterEditMode();
    } else if (!imgEl.classList.contains('hidden')) {
      setStatus('请先渲染 SVG 格式后再进入画板编辑', false);
    } else {
      setStatus('请先渲染预览后再进入画板编辑', false);
    }
  }
}

function enterEditMode() {
  isInEditMode = true;
  const btn = $('btn-edit-mode');
  btn.textContent = '退出画板';
  btn.classList.add('active');

  const mxHost = $('mx-graph-host');
  if (!mxHost) {
    isInEditMode = false;
    btn.textContent = '进入画板';
    btn.classList.remove('active');
    setStatus('画板容器缺失，请更新应用', false);
    return;
  }

  $('preview-placeholder')?.classList.add('hidden');
  $('preview-img')?.classList.add('hidden');
  $('preview-svg')?.classList.add('hidden');

  mxHost.classList.remove('hidden');
  mxHost.setAttribute('aria-hidden', 'false');

  const editor = new MxGraphEditor(mxHost);

  editor.onExportCallback = (data) => {
    if (data.kind === 'svg') {
      addSvgToStash(data.svgText);
    } else if (data.kind === 'png') {
      addPngToStashFromBlob(data.blob);
    }
  };

  editor.init().then(() => {
    const currentSource = $('source').value;
    const converter = new PlantUMLToMxGraphConverter();
    const mxGraphXml = converter.convert(currentSource);
    console.log('Generated mxGraph XML:', mxGraphXml);
    editor.importXML(mxGraphXml);
    svgEditor = editor;
  }).catch(err => {
    console.error('Failed to init mxGraph:', err);
    setStatus('画板编辑器初始化失败: ' + err.message, false);
    isInEditMode = false;
    btn.textContent = '进入画板';
    btn.classList.remove('active');
    $('mx-graph-host')?.classList.add('hidden');
    $('mx-graph-host')?.setAttribute('aria-hidden', 'true');
    const svgWrap = $('preview-svg');
    const imgEl = $('preview-img');
    const ph = $('preview-placeholder');
    if (svgWrap?.querySelector('svg')) {
      svgWrap.classList.remove('hidden');
      ph?.classList.add('hidden');
      imgEl?.classList.add('hidden');
    } else if (imgEl?.getAttribute('src')) {
      imgEl.classList.remove('hidden');
      ph?.classList.add('hidden');
      svgWrap?.classList.add('hidden');
    } else {
      ph?.classList.remove('hidden');
      svgWrap?.classList.add('hidden');
      imgEl?.classList.add('hidden');
    }
  });

  setStatus('已进入画板编辑模式，可拖拽调整元素位置', true);
}

function exitEditMode() {
  isInEditMode = false;
  const btn = $('btn-edit-mode');
  btn.textContent = '进入画板';
  btn.classList.remove('active');

  if (svgEditor) {
    svgEditor.destroy();
    svgEditor = null;
  }

  const mxHost = $('mx-graph-host');
  if (mxHost) {
    mxHost.classList.add('hidden');
    mxHost.setAttribute('aria-hidden', 'true');
  }

  const svgWrap = $('preview-svg');
  const ph = $('preview-placeholder');
  const imgEl = $('preview-img');
  if (svgWrap?.querySelector('svg')) {
    svgWrap.classList.remove('hidden');
    ph?.classList.add('hidden');
    imgEl?.classList.add('hidden');
  } else if (imgEl?.src && imgEl.src.startsWith('blob:') && !imgEl.classList.contains('hidden')) {
    imgEl.classList.remove('hidden');
    ph?.classList.add('hidden');
    svgWrap?.classList.add('hidden');
  } else {
    ph?.classList.remove('hidden');
    svgWrap?.classList.add('hidden');
    imgEl?.classList.add('hidden');
  }

  setStatus('已退出画板编辑模式', true);
}

async function addSvgToStash(svgText) {
  if (!window.studio?.stashAdd) {
    setStatus('暂存区 API 不可用', false);
    return;
  }
  
  try {
    const r = await window.studio.stashAdd({
      kind: 'svg',
      svgText: svgText,
      sourceText: '',
      label: `SVG 产出物 ${new Date().toLocaleString('zh-CN')}`
    });
    
    if (!r?.ok) {
      setStatus(r?.error || '保存失败', false);
      return;
    }
    
    setStatus('已保存 SVG 到暂存区', true);
    await refreshStashList();
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

async function addPngToStashFromBlob(blob) {
  if (!window.studio?.stashAdd) {
    setStatus('暂存区 API 不可用', false);
    return;
  }
  
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const r = await window.studio.stashAdd({
      kind: 'png',
      arrayBuffer: arrayBuffer,
      sourceText: '',
      label: `PNG 产出物 ${new Date().toLocaleString('zh-CN')}`
    });
    
    if (!r?.ok) {
      setStatus(r?.error || '保存失败', false);
      return;
    }
    
    setStatus('已保存 PNG 到暂存区', true);
    await refreshStashList();
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

async function copyStashItem(id) {
  if (!window.studio?.stashGetFull) return;
  const r = await window.studio.stashGetFull(id);
  if (!r?.ok || !r.sourceText) {
    setStatus('没有源码可复制', false);
    return;
  }
  
  try {
    await navigator.clipboard.writeText(r.sourceText);
    setStatus('已复制 PlantUML 源码到剪贴板', true);
  } catch {
    setStatus('复制失败', false);
  }
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
  const tree = $('stash-tree');
  tree.addEventListener('click', (ev) => {
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

function toggleAgentNLPanel() {
  const wrap = $('agent-nl-wrap');
  const btn = $('btn-toggle-agent');
  if (!wrap || !btn) return;

  if (wrap.classList.contains('hidden')) {
    wrap.classList.remove('hidden');
    btn.textContent = '隐藏 Agent';
    syncAgentRequestCounter();
    renderAgentChatSelectUi();
  } else {
    wrap.classList.add('hidden');
    btn.textContent = 'Agent 绘制';
  }
}

function toggleStashPanel() {
  const panel = $('stash-panel');
  
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}

function openAgentSettingsDialog() {
  const dlg = $('agent-settings-dialog');
  dlg.showModal();
}

function closeAgentSettingsDialog() {
  $('agent-settings-dialog')?.close();
}

async function createStashFolder() {
  const dlg = $('stash-folder-dialog');
  const nameInput = $('stash-folder-name');
  nameInput.value = '';
  dlg.showModal();
  requestAnimationFrame(() => {
    nameInput.focus();
  });
}

async function confirmCreateStashFolder() {
  const dlg = $('stash-folder-dialog');
  const name = $('stash-folder-name').value.trim();
  
  if (!name) {
    setStatus('请输入文件夹名称', false);
    return;
  }
  
  if (!window.studio?.stashCreateFolder) {
    setStatus('创建文件夹 API 不可用', false);
    return;
  }
  
  const r = await window.studio.stashCreateFolder({ name });
  
  if (!r?.ok) {
    setStatus(r?.error || '创建失败', false);
    return;
  }
  
  dlg.close();
  setStatus('文件夹已创建', true);
  await refreshStashList();
}

function wireResizer() {
  const resizer = $('resizer');
  const editorPane = $('editor-pane');
  const previewPane = $('preview-pane');
  const layout = document.querySelector('.layout');
  
  if (!resizer || !editorPane || !previewPane || !layout) return;
  
  let isDragging = false;
  
  const MIN_PREVIEW_RATIO = 0.6;
  const MAX_PREVIEW_RATIO = 0.8;
  
  function startDrag(e) {
    isDragging = true;
    resizer.classList.add('dragging');
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
    e.preventDefault();
  }
  
  function onDrag(e) {
    if (!isDragging) return;
    
    const layoutRect = layout.getBoundingClientRect();
    const mouseX = e.clientX - layoutRect.left;
    const totalWidth = layoutRect.width;
    
    const editorWidth = mouseX;
    const previewWidth = totalWidth - editorWidth - 4;
    
    let previewRatio = previewWidth / totalWidth;
    previewRatio = Math.max(MIN_PREVIEW_RATIO, Math.min(MAX_PREVIEW_RATIO, previewRatio));
    
    const newPreviewWidth = totalWidth * previewRatio;
    const newEditorWidth = totalWidth - newPreviewWidth - 4;
    
    editorPane.style.flex = `0 0 ${(newEditorWidth / totalWidth * 100).toFixed(2)}%`;
    previewPane.style.flex = `0 0 ${(newPreviewWidth / totalWidth * 100).toFixed(2)}%`;
  }
  
  function stopDrag() {
    isDragging = false;
    resizer.classList.remove('dragging');
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
  }
  
  resizer.addEventListener('mousedown', startDrag);
}

function isAgentKeyConfigured() {
  return Boolean($('cfg-api-key').value?.trim());
}

async function loadAgentForm() {
  if (!window.studio?.getAgentConfig) return;
  try {
    const c = (await window.studio.getAgentConfig()) || {};
    $('cfg-api-key').value = c.apiKey || '';
    $('cfg-base-url').value = c.baseUrl || '';
    $('cfg-model').value = c.model || '';
    $('cfg-max-retries').value = String(c.maxRetries ?? 3);
    const ig = $('cfg-project-ignore-globs');
    if (ig) ig.value = c.projectIgnoreGlobs || '';
    selectedProjectRoot = String(c.lastProjectRoot || '').trim();
    syncProjectRootDisplay(selectedProjectRoot);
    isChinaUnivMode = Boolean(c.chinaUnivMode);
    const modeCb = $('china-univ-mode');
    if (modeCb) modeCb.checked = isChinaUnivMode;
    if (isChinaUnivMode && $('source').value === DEFAULT_SOURCE) {
      $('source').value = CHINA_UNIV_DEFAULT_SOURCE;
    }
  } catch {
    /* ignore */
  }
}

async function saveAgentForm() {
  if (!window.studio?.setAgentConfig) return;
  try {
    const chinaFromUi = Boolean($('china-univ-mode')?.checked);
    const r = await window.studio.setAgentConfig({
      apiKey: $('cfg-api-key').value,
      baseUrl: $('cfg-base-url').value,
      model: $('cfg-model').value,
      maxRetries: Number($('cfg-max-retries').value),
      projectIgnoreGlobs: projectIgnoreGlobsValue(),
      chinaUnivMode: chinaFromUi,
    });
    if (r && r.ok === false) {
      setStatus(r.error || '未授权：请先在菜单「帮助 → 授权激活」中完成激活后再保存。', false);
      return;
    }
    isChinaUnivMode = chinaFromUi;
    closeAgentSettingsDialog();
    setStatus('已保存 API 与编排设置', true);
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

async function onChinaUnivModeToggle() {
  const cb = $('china-univ-mode');
  if (!cb) return;
  const next = cb.checked;

  try {
    if (next) {
      const ok = await openChinaUnivConfirmDialog();
      if (!ok) {
        cb.checked = false;
        return;
      }
    }

    if (window.studio?.setAgentConfig) {
      const r = await window.studio.setAgentConfig({ chinaUnivMode: next });
      if (r && r.ok === false) {
        cb.checked = !next;
        setStatus(r.error || '未授权：无法保存国内高校模式开关。', false);
        return;
      }
      isChinaUnivMode = next;
      if (isChinaUnivMode && $('source').value === DEFAULT_SOURCE) {
        $('source').value = CHINA_UNIV_DEFAULT_SOURCE;
      }
      setStatus(isChinaUnivMode ? '国内高校模式已开启' : '国内高校模式已关闭', true);
      await syncAgentLockFromMain();
    } else {
      isChinaUnivMode = next;
      if (isChinaUnivMode && $('source').value === DEFAULT_SOURCE) {
        $('source').value = CHINA_UNIV_DEFAULT_SOURCE;
      }
      setStatus(isChinaUnivMode ? '国内高校模式已开启' : '国内高校模式已关闭', true);
      await syncAgentLockFromMain();
    }
  } finally {
    await restoreAgentNlFocus();
    void refreshEditionUi();
  }
}

async function applyAgentRunResult(r) {
  try {
    const logText = (r.logs || []).join('\n');
    recordSessionExecutionLog([logText, r.error && !r.ok ? `错误: ${r.error}` : ''].filter(Boolean).join('\n'));
    const display = r.displaySource != null ? r.displaySource : r.source;
    if (display) $('source').value = display;
    const isArchDraft = Boolean(display && /^@studio-arch\b/i.test(String(display).trim()));
    if (r.locked) {
      document.body.classList.add('studio-agent-source-locked');
      $('source').readOnly = true;
      setPreviewLockOverlay(true);
      updatePayUnlockButtonsVisible(true);
    } else {
      document.body.classList.remove('studio-agent-source-locked');
      $('source').readOnly = false;
      setPreviewLockOverlay(false);
      updatePayUnlockButtonsVisible(false);
    }
    if (r.ok) {
      setStatus(isArchDraft ? '静态架构草稿已填入，正在渲染预览…' : '智能生成成功，正在刷新预览…', true);
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
  } finally {
    void refreshEditionUi();
  }
}

function syncAgentRequestCounter() {
  const ta = $('agent-request');
  const hint = $('agent-request-hint');
  if (!ta) return;
  let v = ta.value;
  let clipped = false;
  if (v.length > AGENT_REQUEST_MAX_CHARS) {
    v = v.slice(0, AGENT_REQUEST_MAX_CHARS);
    ta.value = v;
    clipped = true;
  }
  const len = v.length;
  if (hint) {
    hint.textContent = clipped
      ? `已超过 ${AGENT_REQUEST_MAX_CHARS} 字上限，多出的内容已截断。当前 ${len} / ${AGENT_REQUEST_MAX_CHARS} 字`
      : `${len} / ${AGENT_REQUEST_MAX_CHARS} 字`;
    hint.classList.toggle('agent-request-hint--warn', len >= AGENT_REQUEST_MAX_CHARS);
    hint.classList.toggle(
      'agent-request-hint--near',
      len >= AGENT_REQUEST_MAX_CHARS - 200 && len < AGENT_REQUEST_MAX_CHARS
    );
  }
}

async function runAgent() {
  if (!window.studio?.runAgent) return;
  syncAgentRequestCounter();
  const userText = $('agent-request').value.trim();
  if (!userText) {
    setStatus('请填写自然语言需求', false);
    showToast('请填写自然语言需求', 'info');
    return;
  }
  setStatus('DeepSeek 编排运行中…', null);
  beginStudioBusy('DeepSeek 正在生成 PlantUML…');
  try {
    const r = await window.studio.runAgent({
      userText,
      projectRoot: selectedProjectRoot,
      ignoreGlobsText: projectIgnoreGlobsValue(),
      conversationHistory: getActiveConversationHistoryForApi(),
    });
    await applyAgentRunResult(r);
    if (r?.ok && r.source) {
      await appendSuccessfulAgentTurn(userText, r.source);
      showToast('PlantUML 智能生成成功', 'success');
    } else if (r && r.ok === false) {
      showToast(r.error || '生成失败', 'error');
    }
  } catch (e) {
    const msg = String(e.message || e);
    setStatus(msg, false);
    showToast(msg, 'error');
    reportErrorArchive('agent-exception', msg);
  } finally {
    endStudioBusy();
    void refreshEditionUi();
  }
}

function openProjectImportedDialog(absolutePath) {
  const dlg = $('project-imported-dialog');
  $('project-imported-msg').textContent = `已选择项目目录：\n\n${absolutePath}\n\n索引将在后续生成时在后台构建。`;
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
  try {
    if (!window.studio?.pickProjectDirectory) return;
    const r = await window.studio.pickProjectDirectory();
    if (r.canceled) return;
    if (!r?.ok) {
      const err = r?.error || '无法选择项目目录';
      setStatus(err, false);
      showToast(err, 'error');
      return;
    }
    if (!r.path) return;
    const picked = String(r.path).trim();
    const nextN = normalizeProjectRoot(picked);
    const prevN = normalizeProjectRoot(selectedProjectRoot);

    if (nextN === prevN) {
      showToast('项目目录未变化', 'info');
      return;
    }

    const matches = agentConversationsState.conversations
      .filter((c) => normalizeProjectRoot(c.projectRoot) === nextN)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const active = getActiveAgentConversation();
    const activeN = normalizeProjectRoot(active?.projectRoot || '');
    const activeHasMessages = Boolean(active?.messages?.length);
    const needsSwitchPrompt =
      activeHasMessages || (activeN && activeN !== nextN) || (prevN && prevN !== nextN);

    const applyPickedToConfig = async () => {
      selectedProjectRoot = picked;
      syncProjectRootDisplay(picked);
      if (window.studio.setAgentConfig) {
        const sr = await window.studio.setAgentConfig({ lastProjectRoot: picked });
        if (sr && sr.ok === false) {
          setStatus(sr.error || '已选目录，但未授权无法保存到配置。', false);
          showToast(sr.error || '未授权：目录未保存到配置', 'error');
        }
      }
    };

    if (!needsSwitchPrompt) {
      await applyPickedToConfig();
      if (active) {
        active.projectRoot = picked;
        await persistAgentConversations();
      }
      openProjectImportedDialog(picked);
      showToast('已绑定项目目录到当前对话', 'success');
      return;
    }

    const choice = await openProjectSwitchDialog({
      pickedPath: picked,
      previousLabel: String(selectedProjectRoot || '').trim() || '(未选择)',
      matches,
    });
    await applyPickedToConfig();

    if (choice.kind === 'resume' && choice.conversationId) {
      agentConversationsState.activeId = choice.conversationId;
      const ta = $('agent-request');
      if (ta) ta.value = '';
      syncAgentRequestCounter();
      renderAgentChatSelectUi();
      await persistAgentConversations();
      showToast('已切换到该目录的历史对话', 'success');
      return;
    }

    await createNewAgentConversation();
    showToast('已新建对话并绑定到新项目目录', 'success');
  } finally {
    void refreshEditionUi();
  }
}

async function estimateProjectContext() {
  if (!window.studio?.projectContextEstimate) return;
  if (!selectedProjectRoot) {
    setStatus('请先选择项目目录', false);
    showToast('请先选择项目目录', 'info');
    return;
  }
  syncAgentRequestCounter();
  setStatus('正在估算上下文体积（不调用 DeepSeek）…', null);
  beginStudioBusy('正在估算项目上下文…');
  try {
    const r = await window.studio.projectContextEstimate({
      rootPath: selectedProjectRoot,
      userSample: $('agent-request').value.trim(),
      ignoreGlobsText: projectIgnoreGlobsValue(),
    });
    if (!r?.ok) {
      setStatus(r?.error || '估算失败', false);
      showToast(r?.error || '估算失败', 'error');
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
    showToast(r.exceedsProductLimit ? '估算完成：已超过粗算上限' : '上下文估算完成', r.exceedsProductLimit ? 'error' : 'success');
  } catch (e) {
    const msg = String(e.message || e);
    setStatus(msg, false);
    showToast(msg, 'error');
    reportErrorArchive('estimate-exception', msg);
  } finally {
    endStudioBusy();
    void refreshEditionUi();
  }
}

async function runAgentArchDraft() {
  if (!window.studio?.runAgentArchDraft) return;
  syncAgentRequestCounter();
  const goal = $('agent-request').value.trim();
  if (!goal) {
    setStatus('请填写自然语言需求（例如：标出 renderer 与 electron-main 的依赖关系）', false);
    showToast('请填写自然语言需求', 'info');
    return;
  }
  if (!selectedProjectRoot) {
    setStatus('请先选择项目目录', false);
    showToast('请先选择项目目录', 'info');
    return;
  }
  setStatus('DeepSeek 正在生成 @studio-arch 草稿（独立知识库）…', null);
  beginStudioBusy('DeepSeek 正在生成静态架构草稿…');
  try {
    const r = await window.studio.runAgentArchDraft({
      userText: goal,
      projectRoot: selectedProjectRoot,
      ignoreGlobsText: projectIgnoreGlobsValue(),
    });
    await applyAgentRunResult(r);
    if (r?.ok) {
      showToast('@studio-arch 草稿生成成功', 'success');
    } else if (r && r.ok === false) {
      showToast(r.error || '生成失败', 'error');
    }
  } catch (e) {
    const msg = String(e.message || e);
    setStatus(msg, false);
    showToast(msg, 'error');
    reportErrorArchive('agent-arch-draft-exception', msg);
  } finally {
    endStudioBusy();
    void refreshEditionUi();
  }
}

function openSessionLogDialog() {
  const dlg = $('session-log-dialog');
  const body = $('session-log-dialog-body');
  body.textContent = lastSessionExecutionLog.trim() || '（尚未运行过「智能生成 PlantUML」，或本轮无日志输出）';
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
  wireChinaUnivConfirmDialog();
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
  closeByBackdrop('stash-add-dialog');
  closeByBackdrop('stash-folder-dialog');
  closeByBackdrop('agent-settings-dialog');

  $('agent-advanced-close-x')?.addEventListener('click', () => closeAgentAdvancedDialog());
  $('agent-advanced-close-btn')?.addEventListener('click', () => closeAgentAdvancedDialog());
  $('btn-agent-advanced-save')?.addEventListener('click', async () => {
    if (window.studio?.setAgentConfig) {
      const r = await window.studio.setAgentConfig({ projectIgnoreGlobs: projectIgnoreGlobsValue() });
      if (r && r.ok === false) {
        setStatus(r.error || '未授权：无法保存项目忽略规则。', false);
        return;
      }
      setStatus('已保存项目忽略规则', true);
    }
    closeAgentAdvancedDialog();
  });

  $('session-log-dialog-close')?.addEventListener('click', () => $('session-log-dialog')?.close());
  $('error-log-dialog-close')?.addEventListener('click', () => $('error-log-dialog')?.close());
  $('project-imported-ok')?.addEventListener('click', () => $('project-imported-dialog')?.close());
  $('project-imported-close-x')?.addEventListener('click', () => $('project-imported-dialog')?.close());
  
  $('stash-add-close')?.addEventListener('click', () => $('stash-add-dialog')?.close());
  $('stash-add-cancel')?.addEventListener('click', () => $('stash-add-dialog')?.close());
  $('btn-stash-add-confirm')?.addEventListener('click', () => addCurrentToStashWithFolder());
  
  $('stash-folder-close')?.addEventListener('click', () => $('stash-folder-dialog')?.close());
  $('stash-folder-cancel')?.addEventListener('click', () => $('stash-folder-dialog')?.close());
  $('btn-stash-folder-confirm')?.addEventListener('click', () => confirmCreateStashFolder());
  
  $('agent-settings-close')?.addEventListener('click', () => closeAgentSettingsDialog());
  $('btn-agent-advanced')?.addEventListener('click', () => {
    closeAgentSettingsDialog();
    openAgentAdvancedDialog();
  });
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
    openAgentSettingsDialog();
  });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    openAgentAdvancedDialog();
  });
}

async function syncAgentLockFromMain() {
  if (await isUiAgentLocked()) {
    document.body.classList.add('studio-agent-source-locked');
    $('source').readOnly = true;
    setPreviewLockOverlay(true);
    updatePayUnlockButtonsVisible(true);
  } else {
    document.body.classList.remove('studio-agent-source-locked');
    $('source').readOnly = false;
    setPreviewLockOverlay(false);
    updatePayUnlockButtonsVisible(false);
  }
}

function init() {
  wirePayUnlockConfirmDialog();
  $('china-univ-mode')?.addEventListener('change', () => void onChinaUnivModeToggle());
  
  $('source').value = DEFAULT_SOURCE;
  $('btn-render').addEventListener('click', () => render());
  $('btn-export').addEventListener('click', () => exportFile());
  $('btn-pay-mock-local')?.addEventListener('click', () => runLocalMockPaySuccess());
  $('btn-pay-unlock')?.addEventListener('click', () => beginPayUnlockFlow());
  $('btn-pay-done')?.addEventListener('click', () => confirmPayCompleted());

  let lockOverrideTimer = null;
  $('source').addEventListener('input', () => {
    void (async () => {
      if (!(await isUiAgentLocked())) return;
      const v = $('source').value;
      if (isLockedPlaceholderText(v)) return;
      clearTimeout(lockOverrideTimer);
      lockOverrideTimer = setTimeout(async () => {
        if (!window.studio?.agentLockUserOverride) return;
        const r = await window.studio.agentLockUserOverride({ editorText: $('source').value });
        if (r?.ok) {
          $('source').value = r.editorText || '';
          $('source').readOnly = false;
          document.body.classList.remove('studio-agent-source-locked');
          setPreviewLockOverlay(false);
          updatePayUnlockButtonsVisible(false);
          pendingPayOrderId = '';
          setStatus('已改为手写模式，智能生成锁定已解除', true);
          await render();
        }
      }, 500);
    })();
  });

  $('format').addEventListener('change', clearPreview);

  $('btn-agent-settings').addEventListener('click', () => openAgentSettingsDialog());

  $('btn-save-agent-cfg').addEventListener('click', () => saveAgentForm());
  $('btn-agent-run').addEventListener('click', () => runAgent());
  $('btn-agent-arch-draft')?.addEventListener('click', () => runAgentArchDraft());

  $('agent-request')?.addEventListener('input', () => syncAgentRequestCounter());
  $('agent-request')?.addEventListener('paste', () => {
    queueMicrotask(() => syncAgentRequestCounter());
  });

  $('agent-chat-select')?.addEventListener('change', () => onAgentChatSelectChange());
  $('btn-agent-chat-new')?.addEventListener('click', () => void createNewAgentConversation());
  $('btn-agent-chat-delete')?.addEventListener('click', () => void deleteActiveAgentConversation());

  $('btn-project-pick')?.addEventListener('click', () => pickProjectDirectory());

  $('btn-stash-add').addEventListener('click', () => openStashAddDialog());

  $('btn-edit-mode')?.addEventListener('click', () => toggleEditMode());

  $('btn-stash-refresh').addEventListener('click', () => refreshStashList());
  $('btn-stash-new-folder').addEventListener('click', () => createStashFolder());
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
    toggleStashPanel();
  });

  const stashDlg = $('stash-view-dialog');
  $('stash-dialog-close').addEventListener('click', () => stashDlg.close());
  stashDlg.addEventListener('click', (ev) => {
    if (ev.target === stashDlg) stashDlg.close();
  });

  $('btn-toggle-agent')?.addEventListener('click', () => toggleAgentNLPanel());
  $('btn-toggle-stash')?.addEventListener('click', () => toggleStashPanel());

  wirePreviewContextMenu();
  wireStashGrid();
  wireResizer();

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
  syncAgentRequestCounter();
  void loadAgentConversationsFromDisk();
  loadAgentForm().then(() => {
    syncAgentLockFromMain();
    syncAgentRequestCounter();
  });
  refreshStashList().catch(() => {});

  wireLicenseDialog();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshEditionUi();
  });

  getBase()
    .then((b) => setStatus(`已连接 ${b}`, true))
    .catch((e) => setStatus(String(e.message || e), false))
    .finally(() => void refreshEditionUi());
}

/* ============================================================
 * 授权激活对话框逻辑
 * ============================================================ */

function ensureFreeQuotaPollOnFreeEdition() {
  if (freeQuotaPollTimerId != null) return;
  freeQuotaPollTimerId = window.setInterval(() => {
    if (!document.body.classList.contains('studio-edition-free')) return;
    if (document.body.classList.contains('studio-monthly-active')) return;
    if (document.visibilityState !== 'visible') return;
    void refreshEditionUi();
  }, 50000);
}

async function refreshEditionUi() {
  const badge = $('edition-badge');
  const quotaPill = $('free-quota-pill');
  if (!badge || !window.studio?.licenseGetStatus) return;
  try {
    const s = await window.studio.licenseGetStatus();
    const pro = s.edition === 'pro';
    const monthlyOn = Boolean(s.monthlyPassActive);
    badge.textContent = pro ? '高级版' : '免费版';
    badge.title = pro
      ? '高级版：已激活，全部功能可长期使用'
      : monthlyOn
        ? '当前享有月度专业权益；日免费用量上限不适用'
        : '免费版：智能生成等内容受每日免费用量与条款约束；详见顶栏计数或「帮助 → 授权激活」';
    badge.classList.toggle('edition-badge--pro', pro);
    badge.classList.toggle('edition-badge--free', !pro);
    document.body.classList.toggle('studio-edition-pro', pro);
    document.body.classList.toggle('studio-edition-free', !pro);
    document.body.classList.toggle('studio-monthly-active', monthlyOn && !pro);

    if (quotaPill) {
      const showQuota = !pro && !monthlyOn;
      quotaPill.classList.toggle('hidden', !showQuota);
      if (showQuota) {
        const fl = typeof s.freeDailyLimit === 'number' ? s.freeDailyLimit : 12;
        const fr = typeof s.freeDailyRemaining === 'number' ? s.freeDailyRemaining : 0;
        quotaPill.innerHTML = `今日剩余 <code>${fr}</code>／${fl} 次`;
        quotaPill.title = `当日免费用量剩余 ${fr}/${fl} 次；午夜起按本机日期重置（成功触发需配额的能力后递减）。`;
        quotaPill.classList.remove('free-quota-pill--warn', 'free-quota-pill--empty');
        if (fr <= 0) quotaPill.classList.add('free-quota-pill--empty');
        else if (fr <= Math.max(1, Math.ceil(fl / 3))) quotaPill.classList.add('free-quota-pill--warn');
      }
    }

    ensureFreeQuotaPollOnFreeEdition();
  } catch {
    /* ignore */
  }
}

async function refreshLicenseStatus() {
  if (!window.studio?.licenseGetStatus) return;
  const icon = $('license-status-icon');
  const text = $('license-status-text');
  const deviceArea = $('license-device-area');
  const activateArea = $('license-activate-area');

  try {
    const status = await window.studio.licenseGetStatus();
    const fr = typeof status.freeDailyRemaining === 'number' ? status.freeDailyRemaining : 0;
    const fl = typeof status.freeDailyLimit === 'number' ? status.freeDailyLimit : 12;
    const freeLine = `免费用量：今日剩余 ${fr}/${fl} 次（每日 0 点起按本机日期重置）`;
    if (status.activated) {
      icon.textContent = '✅';
      const mode = status.licenseMode === 'permanent' ? '永久授权' : '限时授权';
      const tier = status.payload?.tier || 'full';
      let base = `已激活 · 高级版（${mode}，等级: ${tier}）`;
      if (status.payload?.valid_until) {
        base += `，激活码有效期至 ${status.payload.valid_until}`;
      }
      const bits = [base];
      if (status.monthlyPassActive && status.monthlyValidUntil) {
        bits.push(`月度权益至 ${status.monthlyValidUntil}`);
      }
      bits.push(freeLine);
      text.textContent = bits.join(' · ');
      deviceArea.classList.add('hidden');
      activateArea.classList.remove('hidden');
      $('license-code-input').value = '';
      $('license-activate-result').classList.add('hidden');
      $('license-monthly-result')?.classList.add('hidden');
    } else {
      icon.textContent = status.monthlyPassActive ? '🎫' : '🔒';
      const edition = status.edition === 'pro' ? '高级版' : '免费版';
      const lines = [];
      lines.push(`${status.error || '未通过软件激活码激活'}（当前：${edition}）`);
      if (status.monthlyPassActive && status.monthlyValidUntil) {
        lines.push(`月度权益至 ${status.monthlyValidUntil}`);
      }
      lines.push(freeLine);
      text.textContent = lines.join('\n');
      deviceArea.classList.remove('hidden');
      activateArea.classList.remove('hidden');
      await refreshDeviceInfo();
    }
    const urlEl = $('license-monthly-server-url');
    if (urlEl && !urlEl.value) {
      try {
        urlEl.value = localStorage.getItem('studio_monthly_server_url') || '';
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    icon.textContent = '❌';
    text.textContent = `检查授权状态失败: ${e.message}`;
  } finally {
    void refreshEditionUi();
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

async function handleLicenseRedeemMonthly() {
  if (!window.studio?.licenseRedeemMonthly) return;
  const key = ($('license-monthly-key-input')?.value || '').trim();
  const serverBase = ($('license-monthly-server-url')?.value || '').trim();
  const resultEl = $('license-monthly-result');
  if (!resultEl) return;
  if (!key) {
    setStatus('请输入月度密钥', false);
    return;
  }
  resultEl.classList.remove('hidden');
  resultEl.textContent = '正在向服务器核销…';
  resultEl.style.color = 'var(--muted)';
  try {
    if (serverBase) {
      try {
        localStorage.setItem('studio_monthly_server_url', serverBase);
      } catch {
        /* ignore */
      }
    }
    const r = await window.studio.licenseRedeemMonthly({ key, serverBase });
    if (r.ok) {
      resultEl.textContent = `✅ 核销成功，权益至 ${r.valid_until}`;
      resultEl.style.color = 'var(--ok)';
      setStatus('月度密钥已核销', true);
      await refreshLicenseStatus();
    } else {
      resultEl.textContent = `❌ ${r.error}`;
      resultEl.style.color = 'var(--error)';
      setStatus('月度密钥核销失败', false);
    }
  } catch (e) {
    resultEl.textContent = `❌ ${e.message}`;
    resultEl.style.color = 'var(--error)';
    setStatus('月度密钥核销异常', false);
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
      await syncAgentLockFromMain();
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
      await syncAgentLockFromMain();
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

  $('license-dialog-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });

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

  $('btn-license-activate').addEventListener('click', () => handleLicenseActivate());

  $('btn-license-redeem-monthly')?.addEventListener('click', () => void handleLicenseRedeemMonthly());

  $('btn-license-deactivate').addEventListener('click', () => handleLicenseDeactivate());

  window.openLicenseDialog = async () => {
    await refreshLicenseStatus();
    if (typeof dlg.showModal === 'function') dlg.showModal();
  };

  if (window.studio?.onMenuLicense) {
    window.studio.onMenuLicense(() => {
      window.openLicenseDialog();
    });
  }
}

init();