import { stripChinaUnivActivityStartEndStereotypes } from '../scripts/china-univ-activity-sanitize.mjs';
import { isLockedPlaceholderText } from '../scripts/agent-session-lock.mjs';
import { parseEditorDocument } from '../scripts/diagram-grammar.mjs';
import { sortSkillsForMenu } from './agent-skills.mjs';

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

:开始;

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

:结束;

@enduml
`;

const $ = (id) => document.getElementById(id);

/** 制图技能挂载的文案以色块存放，拼入发送给主进程的完整需求 */
/** @type {{ uid: string; id: string; label: string; snippet: string; chipTone?: string }[]} */
let attachedAgentSkillEntries = [];

function renderAgentSkillChips() {
  const host = $('agent-skill-chips');
  if (!host) return;
  host.replaceChildren();
  for (const entry of attachedAgentSkillEntries) {
    const chip = document.createElement('span');
    chip.className = 'agent-skill-chip';
    if (entry.chipTone) chip.classList.add(`agent-skill-chip--tone-${entry.chipTone}`);
    chip.dataset.uid = entry.uid;
    chip.setAttribute('role', 'listitem');
    const label = document.createElement('span');
    label.className = 'agent-skill-chip__label';
    label.textContent = entry.label;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'agent-skill-chip__remove';
    x.setAttribute('aria-label', `移除「${entry.label}」`);
    x.textContent = '×';
    x.addEventListener('click', (ev) => {
      ev.preventDefault();
      attachedAgentSkillEntries = attachedAgentSkillEntries.filter((e) => e.uid !== entry.uid);
      renderAgentSkillChips();
      syncAgentRequestCounter();
      $('agent-request')?.focus();
    });
    chip.appendChild(label);
    chip.appendChild(x);
    host.appendChild(chip);
  }
}

function attachAgentSkillFromDef(skill) {
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  attachedAgentSkillEntries.push({
    uid,
    id: skill.id,
    label: skill.label,
    snippet: skill.snippet || '',
    chipTone: skill.chipTone || '',
  });
  renderAgentSkillChips();
  syncAgentRequestCounter();
  $('agent-request')?.focus();
}

function clearAgentRequestCompose() {
  const ta = $('agent-request');
  if (ta) ta.value = '';
  attachedAgentSkillEntries = [];
  clearAttachedReferenceImages();
  renderAgentSkillChips();
  syncAgentRequestCounter();
}

function buildFullAgentUserText() {
  const ta = $('agent-request');
  const tail = String(ta?.value ?? '');
  const pre = attachedAgentSkillEntries.map((e) => e.snippet).join('');
  return `${pre}${tail}`.trim();
}

/** @returns {number} */
function snippetPrefixLength() {
  return attachedAgentSkillEntries.reduce((acc, e) => acc + String(e.snippet || '').length, 0);
}

/** 参考图：由通义 VL 理解后再与正文合并送进 DeepSeek */
const AGENT_REF_IMAGE_MAX_FILES = 4;
const AGENT_REF_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** @type {{ id: string; dataUrl: string }[]} */
let attachedReferenceImages = [];

function renderAgentRefImagePreviews() {
  const host = $('agent-ref-image-previews');
  if (!host) return;
  host.replaceChildren();
  for (const entry of attachedReferenceImages) {
    const tile = document.createElement('div');
    tile.className = 'agent-ref-preview';
    tile.dataset.id = entry.id;
    const im = document.createElement('img');
    im.alt = '参考缩略图';
    im.src = entry.dataUrl;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'agent-ref-preview__rm';
    rm.setAttribute('aria-label', '移除参考图');
    rm.textContent = '×';
    rm.addEventListener('click', () => removeAgentRefImage(entry.id));
    tile.appendChild(im);
    tile.appendChild(rm);
    host.appendChild(tile);
  }
}

function removeAgentRefImage(id) {
  attachedReferenceImages = attachedReferenceImages.filter((x) => x.id !== id);
  renderAgentRefImagePreviews();
}

function clearAttachedReferenceImages() {
  attachedReferenceImages = [];
  renderAgentRefImagePreviews();
}

function approxBase64DecodedBytes(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** @returns {{ mimeType: string; dataBase64: string }[]} */
function getReferenceImagesPayload() {
  /** @type {{ mimeType: string; dataBase64: string }[]} */
  const out = [];
  for (const e of attachedReferenceImages) {
    const raw = String(e.dataUrl || '').trim();
    const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(raw);
    if (!m) continue;
    let mime = String(m[1]).toLowerCase().replace(/\s+/g, '');
    if (!mime.includes('/')) mime = `image/${mime}`;
    let b64 = String(m[2]).replace(/\s+/g, '');
    if (mime === 'image/jpg') mime = 'image/jpeg';
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) continue;
    if (approxBase64DecodedBytes(b64) > AGENT_REF_IMAGE_MAX_BYTES || !b64) continue;
    out.push({ mimeType: mime, dataBase64: b64 });
  }
  return out;
}

/**
 * @param {File[]} files
 */
async function ingestReferenceImageFiles(files) {
  let room = AGENT_REF_IMAGE_MAX_FILES - attachedReferenceImages.length;
  if (room <= 0) {
    showToast(`至多 ${AGENT_REF_IMAGE_MAX_FILES} 张参考图`, 'info');
    return;
  }
  let added = false;
  let limitToast = false;
  for (const file of files) {
    if (room <= 0) {
      if (!limitToast) {
        showToast(`参考图至多 ${AGENT_REF_IMAGE_MAX_FILES} 张`, 'info');
        limitToast = true;
      }
      break;
    }
    if (!(file instanceof File)) continue;
    let mime = String(file.type || '').toLowerCase().trim();
    if (mime === 'image/jpg') mime = 'image/jpeg';
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(mime)) {
      showToast(`已跳过不支持的图像类型：${file.name}`, 'warning');
      continue;
    }
    if (file.size > AGENT_REF_IMAGE_MAX_BYTES) {
      showToast(`图像超过 ${Math.round(AGENT_REF_IMAGE_MAX_BYTES / (1024 * 1024))}MB：${file.name}`, 'warning');
      continue;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('读取图像失败'));
      fr.readAsDataURL(file);
    });
    const b64match = /^data:[^;,]+;base64,([\s\S]+)$/i.exec(dataUrl);
    const b64 = b64match ? String(b64match[1]).replace(/\s+/g, '') : '';
    if (!b64 || approxBase64DecodedBytes(b64) > AGENT_REF_IMAGE_MAX_BYTES) {
      showToast(`无法使用该图像：${file.name}`, 'warning');
      continue;
    }
    attachedReferenceImages.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      dataUrl,
    });
    added = true;
    room -= 1;
  }
  renderAgentRefImagePreviews();
  if (added) showToast('已添加参考图（生成时将先调用通义千问理解图片）', 'success');
}

function wireAgentReferenceImagesUi() {
  const inp = $('agent-ref-image-input');
  if (!inp) return;

  inp.addEventListener('change', () => {
    const list = inp.files ? Array.from(inp.files) : [];
    inp.value = '';
    if (list.length) void ingestReferenceImageFiles(list);
  });
}

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

function deriveStashProjectName(projectRoot) {
  const r = String(projectRoot || '').trim().replace(/\\/g, '/');
  if (!r) return '默认项目';
  const parts = r.split('/').filter(Boolean);
  return parts[parts.length - 1] || '默认项目';
}

function formatStashArchivePathHint(projectRoot) {
  const project = deriveStashProjectName(projectRoot);
  const d = new Date();
  const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${project} / ${dateKey}`;
}

async function addCurrentPreviewToStash(options = {}) {
  if (await isUiAgentLocked()) {
    if (!options.silent) setStatus('免费版：智能生成锁定状态下无法加入暂存区', false);
    return { ok: false, error: 'locked' };
  }
  if (!previewHasContent()) {
    if (!options.silent) setStatus('请先渲染预览再加入暂存区', false);
    return { ok: false, error: 'no preview' };
  }
  const source = $('source').value;
  const imgEl = $('preview-img');
  const svgWrap = $('preview-svg');
  const projectName = deriveStashProjectName(selectedProjectRoot);
  const label =
    options.label ||
    `产出 ${new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })}`;
  let r;
  if (!imgEl.classList.contains('hidden') && imgEl.src) {
    const buf = await (await fetch(imgEl.src)).arrayBuffer();
    r = await window.studio.stashAdd({
      kind: 'png',
      arrayBuffer: buf,
      sourceText: source,
      label,
      projectName,
    });
  } else if (!svgWrap.classList.contains('hidden')) {
    r = await window.studio.stashAdd({
      kind: 'svg',
      svgText: svgWrap.innerHTML,
      sourceText: source,
      label,
      projectName,
    });
  } else {
    if (!options.silent) setStatus('没有可暂存的预览', false);
    return { ok: false, error: 'no preview' };
  }
  if (!r?.ok) {
    if (!options.silent) setStatus(r?.error || '暂存失败', false);
    return r;
  }
  if (!options.silent) {
    setStatus('已加入暂存区', true);
    showToast(`已归档至 ${formatStashArchivePathHint(selectedProjectRoot)}`, 'success');
  }
  await refreshStashList();
  return r;
}

async function maybeAutoStashAfterAgentSuccess() {
  if (!window.studio?.getAgentConfig || !window.studio?.stashAdd) return;
  try {
    const cfg = (await window.studio.getAgentConfig()) || {};
    if (cfg.autoStashOnGenerate === false) return;
    const r = await addCurrentPreviewToStash({ silent: true, label: undefined });
    if (r?.ok) showToast(`已自动加入暂存区（${formatStashArchivePathHint(selectedProjectRoot)}）`, 'success');
  } catch {
    /* ignore */
  }
}

function renderMarkdownHelpArticle(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const parts = [];
  let inCode = false;
  let codeBuf = [];
  let tableBuf = [];
  const flushCode = () => {
    if (!codeBuf.length) return;
    parts.push(`<pre><code>${codeBuf.join('\n').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`);
    codeBuf = [];
  };
  const flushTable = () => {
    if (tableBuf.length < 2) {
      tableBuf = [];
      return;
    }
    const rows = tableBuf.filter((l) => !/^\|[-:\s|]+\|$/.test(l.trim()));
    let html = '<table>';
    rows.forEach((row, idx) => {
      const cells = row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
      const tag = idx === 0 ? 'th' : 'td';
      html += '<tr>' + cells.map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    });
    html += '</table>';
    parts.push(html);
    tableBuf = [];
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        flushTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (line.trim().startsWith('|')) {
      tableBuf.push(line);
      continue;
    }
    flushTable();
    if (line.startsWith('## ')) {
      parts.push(`<h2>${line.slice(3).trim()}</h2>`);
    } else if (line.startsWith('# ')) {
      parts.push(`<h2>${line.slice(2).trim()}</h2>`);
    } else if (line.trim().startsWith('>')) {
      parts.push(`<p><em>${line.replace(/^>\s?/, '').trim()}</em></p>`);
    } else if (line.trim()) {
      parts.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`);
    }
  }
  flushCode();
  flushTable();
  return parts.join('\n');
}

async function openHelpPlantumlDialog() {
  const dlg = $('help-plantuml-dialog');
  const body = $('help-plantuml-body');
  if (!dlg || !body || !window.studio?.helpPlantumlGuide) return;
  body.innerHTML = '<p>正在加载…</p>';
  dlg.showModal();
  try {
    const r = await window.studio.helpPlantumlGuide();
    if (!r?.ok) {
      body.innerHTML = `<p>${r?.error || '加载失败'}</p>`;
      return;
    }
    body.innerHTML = renderMarkdownHelpArticle(r.markdown);
  } catch (e) {
    body.innerHTML = `<p>${String(e.message || e)}</p>`;
  }
}


/** 国内高校模式开关 */
let isChinaUnivMode = false;

/** 最近一轮智能生成 / 项目制图的进程日志（供「文件 → 查看本次执行日志」） */
let lastSessionExecutionLog = '';


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
  clearAgentRequestCompose();
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
  clearAgentRequestCompose();
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
    clearAgentRequestCompose();
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

function updatePayUnlockButtonsVisible(_locked) {
  ['btn-pay-mock-local', 'btn-pay-unlock', 'btn-pay-done'].forEach((id) => {
    const b = $(id);
    if (b) b.classList.add('hidden');
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
  showToast('演示解锁已关闭。请改用「授权激活」中的明码档位（¥9.9／¥39.9／¥299／¥689）。', 'info');
  if (window.openLicenseDialog) await window.openLicenseDialog();
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
  showToast(
    '单笔付费解锁暂未开放。请打开「授权激活」，粘贴明码激活码：¥9.9 当日不限次 · ¥39.9 按月 · ¥299 包年 · ¥689 永久。',
    'info'
  );
  setStatus(
    '请使用明码激活码：¥9.9 当日卡 · ¥39.9 月卡 · ¥299 年卡 · ¥689 永久。菜单「帮助 → 授权激活」。',
    false
  );
  if (window.openLicenseDialog) await window.openLicenseDialog();
}

async function confirmPayCompleted() {
  showToast('单笔支付已不再提供，请在「授权激活」使用明码激活码。', 'info');
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

/** PlantUML PNG 清晰度（矢量/SVG 不受此项影响） */
const PLANTUML_PNG_SCREEN_DPI = 240;

function plantumlFormatRenderOptions(fmt) {
  const f = String(fmt || '');
  if (f === '-tpng') return ['-tpng', `-Sdpi=${PLANTUML_PNG_SCREEN_DPI}`];
  return [fmt];
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

  result = stripChinaUnivActivityStartEndStereotypes(result);

  return result;
}

/** 源码框内容注入 Agent（免费版占位则跳过，避免把锁定提示送给模型） */
function getEditorSourceForAgent() {
  const el = document.getElementById('source');
  if (!el) return '';
  const v = String('value' in el ? el.value : '');
  if (isLockedPlaceholderText(v)) return '';
  return v;
}

/**
 * PicoWeb `/render` 单次请求。
 * @returns {{ outcome: string, errLines?: string[], diagErr?: string, svgText?: string, pngBuf?: ArrayBuffer }}
 */
async function fetchPlantumlRenderOnce(base, source, fmt) {
  const res = await fetch(`${base}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ source, options: plantumlFormatRenderOptions(fmt) }),
  });

  const diagErr = (res.headers.get('x-plantuml-diagram-error') || '').trim();
  const diagLine = res.headers.get('x-plantuml-diagram-error-line');
  const ct = (res.headers.get('content-type') || '').toLowerCase();

  const errLines = [];
  if (diagErr) errLines.push(`x-plantuml-diagram-error: ${diagErr}`);
  if (diagLine) errLines.push(`x-plantuml-diagram-error-line: ${diagLine}`);

  if (!res.ok) {
    const t = await res.text();
    return { outcome: 'http_error', httpStatus: res.status, bodyText: t, errLines };
  }

  if (diagErr) {
    if (fmt === '-tsvg' || ct.includes('svg')) await res.text();
    else await res.arrayBuffer();
    return { outcome: 'plantuml_error', diagErr, diagLine, errLines };
  }

  if (fmt === '-tsvg' || ct.includes('svg')) {
    const svgText = await res.text();
    return { outcome: 'success', svgText, pngBuf: null, errLines };
  }

  const buf = await res.arrayBuffer();
  return { outcome: 'success', svgText: null, pngBuf: buf, errLines };
}

function applyRenderedPreview(fmt, svgText, pngBuf) {
  if (fmt === '-tsvg' || svgText != null) {
    $('preview-placeholder').classList.add('hidden');
    $('preview-img').classList.add('hidden');
    const wrap = $('preview-svg');
    wrap.innerHTML = svgText || '';
    wrap.classList.remove('hidden');
    return;
  }
  const blob = new Blob([pngBuf], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const img = $('preview-img');
  const old = img.src;
  if (old.startsWith('blob:')) URL.revokeObjectURL(old);
  img.src = url;
  img.classList.remove('hidden');
  $('preview-placeholder').classList.add('hidden');
  $('preview-svg').classList.add('hidden');
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

  const rawSource = bundle.source;
  let sourceToRender = rawSource;
  if (isChinaUnivMode) sourceToRender = applyChinaUnivModeIfNeeded(rawSource);
  const univChangedSource = sourceToRender !== rawSource;

  try {
    const base = await getBase();

    /** @type {Awaited<ReturnType<typeof fetchPlantumlRenderOnce>>} */
    let r = await fetchPlantumlRenderOnce(base, sourceToRender, fmt);
    let usedUnivFallback = false;

    if (r.outcome === 'plantuml_error' && isChinaUnivMode && univChangedSource) {
      usedUnivFallback = true;
      showToast('国内高校预处理与当前图不匹配，已自动改用编辑器原始源码渲染', 'info');
      r = await fetchPlantumlRenderOnce(base, rawSource, fmt);
    }

    if (r.outcome === 'http_error') {
      const errBlock = [`HTTP ${r.httpStatus}`, String(r.bodyText || '').slice(0, 2000)];
      showErrors(errBlock, 'render-http');
      setStatus('请求失败', false);
      return;
    }

    if (r.outcome === 'plantuml_error') {
      clearPreview();
      showErrors(
        r.errLines?.length
          ? r.errLines
          : ['PlantUML 报告了语法或图形错误；已隐藏错误占位图（其中可能含有推广链接）。'],
        'preview-plantuml'
      );
      setStatus('渲染失败：请根据上方文本信息修正源码', false);
      return;
    }

    applyRenderedPreview(fmt, r.svgText, r.pngBuf);
    showErrors(r.errLines || []);
    const fbNote = usedUnivFallback && r.outcome === 'success' ? '（已跳过高校预处理）' : '';
    setStatus(r.errLines?.length ? `已渲染（含响应头提示）${fbNote}` : `已渲染${fbNote}`, !r.errLines?.length);
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

  const fmtEl = $('format');
  if (!fmtEl) {
    setStatus('界面未就绪（缺少格式选择控件）', false);
    return;
  }
  const fmt = fmtEl.value;
  const ext = fmt === '-tsvg' ? 'svg' : 'png';
  setStatus('导出中…', null);

  let sourceToExport = bundle.source;
  let rawExport = bundle.source;
  if (isChinaUnivMode) sourceToExport = applyChinaUnivModeIfNeeded(rawExport);
  const univChangedExport = sourceToExport !== rawExport;

  try {
    const base = await getBase();
    let r = await fetchPlantumlRenderOnce(base, sourceToExport, fmt);
    if (r.outcome === 'plantuml_error' && isChinaUnivMode && univChangedExport) {
      showToast('国内高校预处理与当前图不匹配，已自动改用编辑器原始源码导出', 'info');
      r = await fetchPlantumlRenderOnce(base, rawExport, fmt);
    }
    if (r.outcome === 'http_error') {
      setStatus(`导出失败 HTTP ${r.httpStatus}`, false);
      return;
    }
    if (r.outcome === 'plantuml_error') {
      setStatus('PlantUML 报错，已取消导出（避免下载含推广信息的错误图）', false);
      return;
    }
    let blob;
    if (fmt === '-tsvg' || r.svgText != null) {
      blob = new Blob([r.svgText || ''], { type: 'image/svg+xml' });
    } else if (r.pngBuf) {
      blob = new Blob([r.pngBuf], { type: 'image/png' });
    } else {
      setStatus('导出失败：无图像数据', false);
      return;
    }
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
  const pathHint = $('stash-add-path-hint');
  nameInput.value = '';
  if (pathHint) pathHint.textContent = `将保存至：${formatStashArchivePathHint(selectedProjectRoot)}`;
  dlg.showModal();
  requestAnimationFrame(() => nameInput.focus());
}

async function addCurrentToStashWithFolder() {
  const dlg = $('stash-add-dialog');
  const name = $('stash-add-name').value.trim();
  dlg.close();
  setStatus('正在写入暂存区…', null);
  await addCurrentPreviewToStash({ label: name || undefined });
}

async function refreshStashList() {
  if (!window.studio?.stashList) return;
  const r = await window.studio.stashList();
  const tree = $('stash-tree');
  const empty = $('stash-empty');
  if (!r?.ok) {
    $('stash-count').textContent = '0 项';
    empty.classList.remove('hidden');
    tree.classList.add('hidden');
    tree.innerHTML = '';
    return;
  }
  const items = r.items || [];
  $('stash-count').textContent = `${items.length} 项`;
  if (!items.length) {
    empty.classList.remove('hidden');
    tree.classList.add('hidden');
    tree.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  tree.classList.remove('hidden');
  tree.innerHTML = '';

  const grouped = new Map();
  for (const it of items) {
    const project = it.projectName || '默认项目';
    const dateKey = it.dateKey || '未知日期';
    if (!grouped.has(project)) grouped.set(project, new Map());
    const dates = grouped.get(project);
    if (!dates.has(dateKey)) dates.set(dateKey, []);
    dates.get(dateKey).push(it);
  }

  const archiveRoot = document.createElement('div');
  archiveRoot.className = 'stash-archive-tree';

  for (const [projectName, datesMap] of grouped) {
    const projectEl = document.createElement('section');
    projectEl.className = 'stash-archive-project';

    const head = document.createElement('div');
    head.className = 'stash-archive-project__head';
    head.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg><span>${projectName}</span>`;
    projectEl.appendChild(head);

    const sortedDates = [...datesMap.keys()].sort((a, b) => b.localeCompare(a));
    for (const dateKey of sortedDates) {
      const dateBlock = document.createElement('div');
      dateBlock.className = 'stash-archive-date';

      const dateHead = document.createElement('div');
      dateHead.className = 'stash-archive-date__head';
      dateHead.textContent = dateKey;
      dateBlock.appendChild(dateHead);

      const grid = document.createElement('div');
      grid.className = 'stash-grid';
      for (const it of datesMap.get(dateKey)) {
        grid.appendChild(createStashCard(it));
      }
      dateBlock.appendChild(grid);
      projectEl.appendChild(dateBlock);
    }
    archiveRoot.appendChild(projectEl);
  }
  tree.appendChild(archiveRoot);
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
      label: `SVG 产出物 ${new Date().toLocaleString('zh-CN')}`,
      projectName: deriveStashProjectName(selectedProjectRoot),
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
      label: `PNG 产出物 ${new Date().toLocaleString('zh-CN')}`,
      projectName: deriveStashProjectName(selectedProjectRoot),
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
    const autoSt = $('cfg-auto-stash');
    if (autoSt) autoSt.checked = c.autoStashOnGenerate !== false;
    const qwk = $('cfg-qwen-api-key');
    const qwu = $('cfg-qwen-base-url');
    const qwm = $('cfg-qwen-vision-model');
    if (qwk) qwk.value = c.qwenApiKey || '';
    if (qwu) qwu.value = c.qwenBaseUrl || '';
    if (qwm) qwm.value = c.qwenVisionModel || '';
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
      qwenApiKey: $('cfg-qwen-api-key')?.value ?? '',
      qwenBaseUrl: $('cfg-qwen-base-url')?.value ?? '',
      qwenVisionModel: $('cfg-qwen-vision-model')?.value ?? '',
      projectIgnoreGlobs: projectIgnoreGlobsValue(),
      chinaUnivMode: chinaFromUi,
      autoStashOnGenerate: Boolean($('cfg-auto-stash')?.checked),
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
      await maybeAutoStashAfterAgentSuccess();
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
  const prefix = snippetPrefixLength();
  if (prefix > AGENT_REQUEST_MAX_CHARS && hint) {
    hint.textContent = `制图技能片段已超过 ${AGENT_REQUEST_MAX_CHARS} 字，请先移除部分能力标签`;
    hint.classList.add('agent-request-hint--warn');
    hint.classList.remove('agent-request-hint--near');
    return;
  }
  const maxTail = Math.max(0, AGENT_REQUEST_MAX_CHARS - prefix);
  let v = ta.value;
  let clipped = false;
  if (v.length > maxTail) {
    v = v.slice(0, maxTail);
    ta.value = v;
    clipped = true;
  }
  const tailLen = v.length;
  const total = prefix + tailLen;
  if (hint) {
    hint.textContent = clipped
      ? `总需求超过 ${AGENT_REQUEST_MAX_CHARS} 字，已截断正文。当前合计 ${total} / ${AGENT_REQUEST_MAX_CHARS}（技能 ${prefix}+正文 ${tailLen}）`
      : `合计 ${total} / ${AGENT_REQUEST_MAX_CHARS} 字（技能片段 ${prefix} + 正文 ${tailLen}）`;
    hint.classList.toggle('agent-request-hint--warn', total >= AGENT_REQUEST_MAX_CHARS);
    hint.classList.toggle(
      'agent-request-hint--near',
      total >= AGENT_REQUEST_MAX_CHARS - 200 && total < AGENT_REQUEST_MAX_CHARS,
    );
  }
}

async function runAgent() {
  if (!window.studio?.runAgent) return;
  syncAgentRequestCounter();
  const userText = buildFullAgentUserText();
  const refPayload = getReferenceImagesPayload();
  if (!userText) {
    setStatus('请填写自然语言需求', false);
    showToast('请填写自然语言需求', 'info');
    return;
  }
  const busyHint = refPayload.length
    ? '通义千问正在理解附图，随后由 DeepSeek 生成 PlantUML…'
    : 'DeepSeek 正在生成 PlantUML…';
  setStatus('DeepSeek 编排运行中…', null);
  beginStudioBusy(busyHint);
  try {
    const r = await window.studio.runAgent({
      userText,
      referenceImages: refPayload,
      editorSource: getEditorSourceForAgent(),
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
      clearAgentRequestCompose();
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
      userSample: buildFullAgentUserText(),
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
  const goal = buildFullAgentUserText();
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
      editorSource: getEditorSourceForAgent(),
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
  $('help-plantuml-close')?.addEventListener('click', () => $('help-plantuml-dialog')?.close());
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

/** Agent「+」菜单与制图技能（空行 "/" 唤出列表）插入片段 */
let agentSkillsOpen = false;
/** @type {boolean} */
let agentInsertMenuOpen = false;

function closeAgentInsertMenu() {
  const btn = $('btn-agent-insert');
  const menu = $('agent-insert-menu');
  if (!agentInsertMenuOpen) return;
  if (menu) menu.classList.add('hidden');
  agentInsertMenuOpen = false;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', agentInsertOutsideClose, true);
}

/** @param {MouseEvent} ev */
function agentInsertOutsideClose(ev) {
  const anchor = $('agent-insert-anchor');
  if (anchor?.contains(/** @type {Node} */ (ev.target))) return;
  closeAgentInsertMenu();
}

function toggleAgentInsertMenu() {
  if (agentSkillsOpen) closeAgentSkillsPopover();
  if (agentInsertMenuOpen) {
    closeAgentInsertMenu();
    return;
  }
  const menu = $('agent-insert-menu');
  const btn = $('btn-agent-insert');
  if (!menu || !btn) return;
  menu.classList.remove('hidden');
  agentInsertMenuOpen = true;
  btn.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('mousedown', agentInsertOutsideClose, true), 0);
}

/** 在编排卡片内 Ctrl+V：从剪贴板追加参考图（与文件选择链路一致）。 */
function wireAgentComposePasteImages() {
  const wrap = $('agent-compose');
  if (!wrap) return;
  wrap.addEventListener(
    'paste',
    /** @param {ClipboardEvent} ev */ (ev) => {
      const dt = ev.clipboardData;
      if (!dt?.items?.length) return;
      /** @type {File[]} */
      const imageFiles = [];
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        if (item.kind !== 'file') continue;
        const f = item.getAsFile();
        if (!f || !/^image\//i.test(String(f.type || '').trim())) continue;
        imageFiles.push(f);
      }
      if (!imageFiles.length) return;
      ev.preventDefault();
      void ingestReferenceImageFiles(imageFiles);
    },
  );
}

function rebuildAgentSkillsOptions() {
  const pop = $('agent-skills-popover');
  if (!pop) return;
  pop.replaceChildren();
  const sorted = sortSkillsForMenu(Boolean(isChinaUnivMode));
  sorted.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-skill-option';
    if (s.menuTone) btn.classList.add(`agent-skill-option--tone-${s.menuTone}`);
    btn.setAttribute('role', 'option');
    const thumb = document.createElement('img');
    thumb.src = s.preview;
    thumb.alt = '';
    thumb.width = 120;
    thumb.height = 70;
    thumb.className = 'agent-skill-thumb';
    thumb.loading = 'lazy';
    const meta = document.createElement('div');
    meta.className = 'agent-skill-option__meta';
    const lab = document.createElement('div');
    lab.className = 'agent-skill-option__label';
    lab.textContent = s.label;
    const desc = document.createElement('div');
    desc.className = 'agent-skill-option__desc';
    desc.textContent = s.desc;
    meta.appendChild(lab);
    meta.appendChild(desc);
    btn.appendChild(thumb);
    btn.appendChild(meta);
    btn.addEventListener('click', () => {
      attachAgentSkillFromDef(s);
      closeAgentSkillsPopover();
    });
    pop.appendChild(btn);
  });
}

function openAgentSkillsPopover() {
  const pop = $('agent-skills-popover');
  if (!pop || agentSkillsOpen) return;
  closeAgentInsertMenu();
  rebuildAgentSkillsOptions();
  pop.classList.remove('hidden');
  agentSkillsOpen = true;
  setTimeout(() => document.addEventListener('mousedown', agentSkillsOutsideClose, true), 0);
}

/** @param {MouseEvent} ev */
function agentSkillsOutsideClose(ev) {
  const anchor = $('agent-insert-anchor');
  if (anchor?.contains(ev.target)) return;
  closeAgentSkillsPopover();
}

function closeAgentSkillsPopover() {
  const pop = $('agent-skills-popover');
  if (!agentSkillsOpen) return;
  if (pop) pop.classList.add('hidden');
  agentSkillsOpen = false;
  document.removeEventListener('mousedown', agentSkillsOutsideClose, true);
}

function wireAgentDrawingSkillsUi() {
  const ta = $('agent-request');
  if (!ta) return;

  $('btn-agent-insert')?.addEventListener('click', (e) => {
    e.preventDefault();
    toggleAgentInsertMenu();
  });

  $('agent-insert-option-skills')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeAgentInsertMenu();
    openAgentSkillsPopover();
  });

  $('agent-insert-option-ref')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeAgentInsertMenu();
    $('agent-ref-image-input')?.click();
  });

  ta.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.tagName !== 'TEXTAREA') return;
    const textarea = /** @type {HTMLTextAreaElement} */ (target);
    const start = textarea.selectionStart ?? 0;
    const before = textarea.value.slice(0, start);
    if (!/^\s*$/.test(before)) return;
    e.preventDefault();
    if (agentSkillsOpen) closeAgentSkillsPopover();
    else openAgentSkillsPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (agentInsertMenuOpen) closeAgentInsertMenu();
    else if (agentSkillsOpen) closeAgentSkillsPopover();
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
  wireAgentDrawingSkillsUi();
  wireAgentReferenceImagesUi();
  wireAgentComposePasteImages();
  renderAgentSkillChips();

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
  /* 暂存区按项目/日期自动归档 */
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
  if (window.studio?.onMenuPlantumlGuide) {
    window.studio.onMenuPlantumlGuide(() => void openHelpPlantumlDialog());
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
        ? '高级版：已激活专业权益（明码激活码 / 买断）'
        : monthlyOn
          ? '当前享有附加专业权益窗口；日免费用量上限不适用'
          : '免费版：单笔在线支付暂未开放；用完后可使用明码激活码（¥9.9／¥39.9／¥299／¥689），详见「授权激活」。';
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
        quotaPill.title = `当日免费用量剩余 ${fr}/${fl} 次；午夜起按本机日期重置（成功触发需配额的能力后递减）。用尽后可使用明码激活码（¥9.9／¥39.9／¥299／¥689）。`;
        quotaPill.classList.remove('free-quota-pill--warn', 'free-quota-pill--empty');
        if (fr <= 0) quotaPill.classList.add('free-quota-pill--empty');
        else if (fr <= Math.max(1, Math.ceil(fl / 3))) quotaPill.classList.add('free-quota-pill--warn');
        if (fr <= 0) {
          try {
            const dk = new Date().toLocaleDateString('sv-SE');
            const sk = `studio_quota_exhaust_${dk}`;
            if (!sessionStorage.getItem(sk)) {
              sessionStorage.setItem(sk, '1');
              showToast(
                '今日免费次数已用完。可在「帮助 → 授权激活」使用明码：¥9.9 当日卡 · ¥39.9 月卡 · ¥299 年卡 · ¥689 永久。',
                'info'
              );
            }
          } catch {
            /* ignore */
          }
        }
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
      const slab = typeof status.commercialOfferLabel === 'string' ? status.commercialOfferLabel.trim() : '';
      let base = `已激活 · 高级版（${mode}，等级: ${tier}）`;
      if (slab) base += ` · ${slab}`;
      if (status.payload?.valid_until) {
        base += `，权益至 ${status.payload.valid_until}`;
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