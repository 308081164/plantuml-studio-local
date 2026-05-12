import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, session, shell } from 'electron';
import { spawn, execSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';

/** 部分网络环境下 IPv6 优先会导致 TLS/连接间歇失败，优先尝试 IPv4 */
try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch {
  /* ignore */
}
import { buildZhMenu } from './scripts/app-menu.mjs';
import {
  generateHwId,
  generateDeviceCode,
  validateLicenseCode,
  readLicense,
  writeLicense,
  checkLicenseStatus,
  getLicensePath,
  shortHwId,
  resolveIssuerPublicKeyBuffer,
} from './scripts/license-common.mjs';
import {
  buildProjectSummary,
  CHARS_PER_TOKEN_EST,
  collectProjectManifest,
  estimateTokens,
  heuristicPrioritizedPaths,
  MAX_ASSEMBLED_USER_TOKENS,
  parseIgnoreGlobLines,
} from './scripts/project-index.mjs';
import {
  assembleUserBlock,
  buildFileBundle,
  buildProjectUserBlockParts,
  checkAssembledContextLimit,
  computeBundleCharBudget,
  formatManifestJsonl,
  parsePlannerPaths,
} from './scripts/project-context.mjs';
import {
  classifyDiagramIntent,
  shouldApplyChinaUnivPostProcess,
  wantsProjectCodeContext,
} from './scripts/agent-intent.mjs';
import { buildArchAgentSystemPrompt } from './scripts/arch-agent-prompt.mjs';
import { buildKnowledgeInjection, resolveJarLabelFromDirs } from './scripts/kb-inject.mjs';
import { parseEditorDocument } from './scripts/diagram-grammar.mjs';
import { renderStudioArchSvg } from './scripts/studio-arch-graph.mjs';
import { buildLockedEditorPlaceholder } from './scripts/agent-session-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let javaChild = null;
let apiBase = null;

/** 用户已确认退出（避免重复弹窗 / 与 before-quit 二次进入配合） */
let exitConfirmed = false;
/** 致命错误等路径：不弹退出确认，直接退出 */
let skipExitConfirmOnce = false;

/** 免费版：智能生成成功后的会话锁（明文仅驻主进程） */
let agentSessionLock = null;

function quitAppWithoutConfirm() {
  skipExitConfirmOnce = true;
  app.quit();
}

const DEFAULT_AGENT = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  /** 首次生成失败后，额外允许的 DeepSeek 修正轮数（总调用次数 ≤ 1 + maxRetries） */
  maxRetries: 3,
  /** 上次选择的项目根目录（仅本地配置，不提交仓库） */
  lastProjectRoot: '',
  /** 自定义忽略 glob，一行一条（与 .gitignore 叠加） */
  projectIgnoreGlobs: '',
  /** 国内高校模式开关（生成符合国内标准的流程图） */
  chinaUnivMode: false,
};

function agentConfigPath() {
  return join(app.getPath('userData'), 'studio-agent-config.json');
}

function loadAgentConfig() {
  try {
    const p = agentConfigPath();
    if (!existsSync(p)) return { ...DEFAULT_AGENT };
    const raw = readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    if (typeof j !== 'object' || j === null || Array.isArray(j)) {
      return { ...DEFAULT_AGENT };
    }
    return {
      ...DEFAULT_AGENT,
      ...j,
      apiKey: typeof j.apiKey === 'string' ? j.apiKey : '',
      baseUrl: typeof j.baseUrl === 'string' && j.baseUrl.trim() ? j.baseUrl.trim() : DEFAULT_AGENT.baseUrl,
      model: typeof j.model === 'string' && j.model.trim() ? j.model.trim() : DEFAULT_AGENT.model,
      maxRetries: Number.isFinite(Number(j.maxRetries)) ? Math.max(0, Math.min(15, Number(j.maxRetries))) : DEFAULT_AGENT.maxRetries,
      lastProjectRoot: typeof j.lastProjectRoot === 'string' ? j.lastProjectRoot : '',
      projectIgnoreGlobs:
        typeof j.projectIgnoreGlobs === 'string'
          ? j.projectIgnoreGlobs
          : Array.isArray(j.projectIgnoreGlobs)
          ? j.projectIgnoreGlobs.map(String).join('\n')
          : '',
      chinaUnivMode: j.chinaUnivMode === true || j.chinaUnivMode === 'true',
    };
  } catch {
    return { ...DEFAULT_AGENT };
  }
}

function saveAgentConfig(partial) {
  const cur = loadAgentConfig();
  const next = {
    ...cur,
    ...partial,
    baseUrl: partial.baseUrl != null ? String(partial.baseUrl).trim() || DEFAULT_AGENT.baseUrl : cur.baseUrl,
    model: partial.model != null ? String(partial.model).trim() || DEFAULT_AGENT.model : cur.model,
    maxRetries:
      partial.maxRetries != null
        ? Math.max(0, Math.min(15, Number(partial.maxRetries) || 0))
        : cur.maxRetries,
  };
  if (partial.apiKey !== undefined) next.apiKey = String(partial.apiKey);
  if (partial.lastProjectRoot !== undefined) next.lastProjectRoot = String(partial.lastProjectRoot);
  if (partial.projectIgnoreGlobs !== undefined) next.projectIgnoreGlobs = String(partial.projectIgnoreGlobs);
  if (partial.chinaUnivMode !== undefined) next.chinaUnivMode = partial.chinaUnivMode ? true : false;
  const dir = dirname(agentConfigPath());
  mkdirSync(dir, { recursive: true });
  writeFileSync(agentConfigPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function findKnowledgeBasePath() {
  const candidates = [
    join(process.resourcesPath || '', 'kb', 'PlantUML-Agent-Knowledge-Base.md'),
    join(__dirname, 'vendor', 'kb', 'PlantUML-Agent-Knowledge-Base.md'),
    join(__dirname, '..', 'PlantUML-Agent-Knowledge-Base.md'),
    join(__dirname, 'PlantUML-Agent-Knowledge-Base.md'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function findArchKnowledgeBasePath() {
  const candidates = [
    join(process.resourcesPath || '', 'kb', 'Studio-Arch-Agent-Knowledge-Base.md'),
    join(__dirname, 'vendor', 'kb', 'Studio-Arch-Agent-Knowledge-Base.md'),
    join(__dirname, '..', 'Studio-Arch-Agent-Knowledge-Base.md'),
    join(__dirname, 'Studio-Arch-Agent-Knowledge-Base.md'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function resolvePlantumlJarLabelForPrompt() {
  const vendorJar = join(__dirname, 'vendor', 'plantuml');
  const resLibs = join(process.resourcesPath || '', 'plantuml');
  return resolveJarLabelFromDirs([resLibs, vendorJar]);
}

/**
 * @param {{ l0: string, kbExcerpt: string, selectedTitles?: string[], intent?: string }} kbPayload
 * @param {*} cfg
 */
function buildAgentSystemPrompt(kbPayload, cfg) {
  const safeCfg = { ...DEFAULT_AGENT, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const l0 = String(kbPayload?.l0 || '').trim();
  const kbExcerpt = String(kbPayload?.kbExcerpt || '').trim();
  const titles = Array.isArray(kbPayload?.selectedTitles) ? kbPayload.selectedTitles.filter(Boolean) : [];
  const intentTag = kbPayload?.intent ? String(kbPayload.intent) : '';
  const kbBlock =
    kbExcerpt.length > 0
      ? `\n【知识库摘录（非全文）】章节参考：${titles.length ? titles.join('、') : '自动路由'}；意图：${intentTag || 'n/a'}\n${kbExcerpt}`
      : '';
  const chinaModeExtra = safeCfg.chinaUnivMode ? `
===== 【国内高校模式：强制输出规则】 =====
【专规优先声明】本节覆盖与本节冲突的通用表述（例如通用规则中的「可用 note 写假设」：@startchen 与国内高校活动图专规不适用处，以本节为准）。
1️⃣ 第一行必须是：@startuml activity
   ❌ 错误写法：@startuml（后面不加 activity 会报错）
   ✅ 正确写法：@startuml activity

2️⃣ 接下来必须是这 3 行 skinparam：
   skinparam ActivityShape roundedbox
   skinparam ConditionStyle InsideDiamond
   skinparam ConditionEndStyle HLine

3️⃣ 开始节点必须是：:开始;（不带任何标签）
   ❌ 错误写法：start
   ❌ 错误写法：:开始; <<task>>
   ✅ 正确写法：:开始;

4️⃣ 结束节点必须是：:结束;（不带任何标签）
   ❌ 错误写法：stop
   ❌ 错误写法：:结束; <<task>>
   ✅ 正确写法：:结束;

5️⃣ 【核心节点形状选择规则（**重要！）
   - 处理/操作节点：:内容; <<task>>
     直角矩形，表示对数据进行运算、赋值、转换等处理
     使用场景：计算总分、格式转换、更新数据库、调用API、判断分支前的准备

   - 输入/输出节点：:内容; <<save>>
     平行四边形，表示与外部环境进行数据交互
     使用场景：读取用户输入、打印报表、显示结果、从文件读数据

   - 属性节点（椭圆）：:内容; <<cn-ellipse>>
     椭圆形状，用于表示实体的属性（陈氏ER图专用）
     使用场景：学号、姓名、课程号等

   【判断原则：
   矩形 <<task>>：内部逻辑改变数据的内容、结构或存储位置。只要数据"发生某种变化"（包括赋值、计算、判断分支前的准备），就用矩形。
   平行四边形 <<save>>：数据从外部（键盘、文件、网络、传感器）进入系统，或从系统输出到外部（屏幕、打印机、文件）。数据"过路"而不改变其值、不产生新值。
   椭圆 <<cn-ellipse>>：用于陈氏ER图中的属性表示。

   【示例】
   :计算总分 = 语文 + 数学; <<task>>
   :请输入用户名; <<save>>
   :显示错误信息"密码错误"; <<save>>
   :学号; <<cn-ellipse>>
   :姓名; <<cn-ellipse>>

6️⃣ 【陈氏ER图特殊规则】
   当用户要求绘制ER图、实体关系图、E-R图、数据库概念模型时，**必须使用 @startchen 语法**：
   
   【核心语法】
   - 实体（矩形）：entity "显示名" as 别名 { 属性定义 }
     - 属性定义格式：每行一个属性，主键加 <<key>>
     - 示例：entity "学生" as Student { 学号 <<key>> 姓名 }
   - 关系（菱形）：relationship "显示名" as 别名 { }
     - ⚠️ 注意：花括号必须单独占一行！
     - ❌ 错误：relationship "拥有" as Own { }
     - ✅ 正确：relationship "拥有" as Own {
       }
   - 连接与基数：使用 -1- / -N- / -M- 连接
   
   【基数含义】
   - -1- : 一对一关系
   - -N- : 一对多关系  
   - -M- : 多对多关系
   
   【属性类型标记】
   - <<key>> : 主键/唯一标识（如学号）
   - <<derived>> : 派生属性（如年龄）
   - <<multi>> : 多值属性（如电话）
   
   【布局优化配置】
   skinparam defaultFontSize 20
   skinparam dpi 150
   skinparam spacing 50
   
   <style>
   chenEntity {
     BackGroundColor white
     BorderColor black
     FontSize 20
   }
   chenRelationship {
     BackGroundColor white
     BorderColor black
     FontSize 20
   }
   chenAttribute {
     BackGroundColor white
     BorderColor black
     FontSize 18
   }
   </style>

   【陈氏ER图完整示例】
   @startchen "学生选课系统 ER 图（陈氏表示法）"
   left to right direction
   
   skinparam defaultFontSize 20
   skinparam dpi 150
   skinparam spacing 50
   
   <style>
   chenEntity {
     BackGroundColor white
     BorderColor black
     FontSize 20
   }
   chenRelationship {
     BackGroundColor white
     BorderColor black
     FontSize 20
   }
   chenAttribute {
     BackGroundColor white
     BorderColor black
     FontSize 18
   }
   </style>
   
   entity "学生" as Student {
     学号 <<key>>
     姓名
     年龄
     班号
   }
   
   entity "课程" as Course {
     课程号 <<key>>
     课程名
     学分
   }
   
   entity "教师" as Teacher {
     教师号 <<key>>
     姓名
     职称
   }
   
   relationship "选修" as Enroll {
   }
   relationship "讲授" as Teach {
   }
   
   Student -N- Enroll
   Enroll -N- Course
   
   Teacher -1- Teach
   Teach -N- Course
   @endchen
   
   【注意】
   - ER图使用 @startchen/@endchen，不需要 @startuml activity
   - ⚠️ 严禁使用 note 指令！Chen ER 图语法不支持 note，使用会导致语法错误
   - 如果需要添加说明，请在实体属性中用注释或在关系名称中体现

7️⃣ 每一步的输出结构（严格按顺序）：
   @startuml activity
   title [流程图标题]
   skinparam ActivityShape roundedbox
   skinparam ConditionStyle InsideDiamond
   skinparam ConditionEndStyle HLine
   skinparam activity {
     BorderColor black
     BackgroundColor white
     ArrowColor black
   }
   :开始; <<task>>
   [用户需求的流程图内容]
   :结束; <<task>>
   @enduml

8️⃣ 完整示例参考（登录流程）：
@startuml activity
title 登录流程图（国内标准写法）
skinparam ActivityShape roundedbox
skinparam ConditionStyle InsideDiamond
skinparam ConditionEndStyle HLine
skinparam activity {
  BorderColor black
  BackgroundColor white
  ArrowColor black
}
:开始; <<task>>
:用户打开登录页面; <<task>>
:输入用户名和密码; <<save>>
:点击登录按钮; <<task>>
:系统校验输入是否为空; <<task>>
if (用户名或密码为空?) then (是)
  :提示"用户名或密码不能为空"; <<save>>
else (否)
  :系统查询用户信息; <<task>>
  if (用户存在?) then (否)
    :提示"用户不存在"; <<save>>
  else (是)
    :校验密码是否正确; <<task>>
    if (密码正确?) then (否)
      :提示"密码错误"; <<save>>
    else (是)
      :生成登录令牌(Token); <<task>>
      :记录登录日志; <<task>>
      :跳转到系统主页; <<task>>
      :显示登录成功; <<save>>
    endif
  endif
endif
:结束; <<task>>
@enduml
===== 【国内高校模式强制禁止】 =====
❌ 绝对不允许写 start
❌ 绝对不允许写 stop
❌ 绝对不允许 @startuml 后面不加 activity
❌ 开始/结束 一定要加 <<task>>
===== 【输出要求】 =====
直接输出 PlantUML 代码即可，不要任何 Markdown 解释或代码块包裹（除非你想，但代码块里的内容必须是完整 PlantUML）。
` : '';
  return [
    l0,
    '你是 PlantUML 专家。用户会用自然语言描述要画的图。',
    '你必须只输出一段完整、可渲染的 PlantUML 源码，且必须包含 @startuml 与 @enduml（或当前任务要求的其它 @start...@end 对）。',
    '不要输出 Markdown 解释；若用代码块包裹，块内仍须是完整 PlantUML。',
    '【规则优先级】通用规则允许「信息不足时在图内用 note 写假设」；若用户或任务要求 @startchen 或国内高校活动图专规，则以对应专规为准（Chen 严禁 note）。',
    kbBlock,
    chinaModeExtra,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildAgentSystemPromptForProject(kbPayload, cfg) {
  const safeCfg = { ...DEFAULT_AGENT, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  return `${buildAgentSystemPrompt(kbPayload, safeCfg)}\n\n【项目模式】用户会提供本地工程目录的索引与「规划阶段」选出的若干源文件全文（受控长度）。请结合这些内容制图；若仍有信息缺口且非 @startchen，在图中用 note 标明假设与未读到的模块。`;
}

/** 附在 PlantUML 校验失败后的修正轮 user 消息中，针对高频语法坑（如 title 行内字面 \\n） */
const PLANTUML_RETRY_HINT =
  '\n\n【PlantUML 常见修复】`title` 只能写单行标题；不要在 `title ...` 内写字面量 `\\n` 或拆成第二行。副标题请用 `caption ...`、`header` / `right header` 或 `floating note`。请输出与下面「当前源码」不完全相同、且可被 PlantUML 解析的完整源码。';

const PROJECT_PLANNER_SYSTEM = [
  '你是资深软件架构分析助手。',
  '用户会给出「制图目标」和一份 JSONL 文件清单（每行一个 JSON：path, bytes, ext, head）。',
  '你必须只输出一个 JSON 对象，不要使用 markdown 代码围栏。',
  'JSON 格式：{"paths":["相对路径1", ...], "rationale":"一句话说明为何选这些文件", "diagram_guess":"推断图种/意图（如 时序图/类图/活动图/Chen ER）", "risk_notes":"缺信息或易错点（可为空字符串）"}。',
  'paths 数组最多 35 个字符串，且每个必须原样来自清单中的 path 字段。',
  'diagram_guess、risk_notes 为短字符串即可，勿写长文。',
  '优先选择能支撑用例图/类图/时序图/部署图推断的：入口、路由、领域模型、API、配置与依赖声明。',
].join('');

/**
 * 从模型整段回复中取出 PlantUML。修正轮次模型常在文首保留旧版 fenced 块、在文末再给新版，
 * 若始终取「第一个」非贪婪 ``` 块会导致多轮校验永远对着同一份源码（用户日志中多轮字符数相同即此类问题）。
 */
function extractPlantumlFromModelText(text) {
  if (!text || typeof text !== 'string') return '';
  const fenceRe = /```(?:plantuml|puml|uml)?\s*([\s\S]*?)```/gi;
  const fencedBodies = [];
  let fm;
  while ((fm = fenceRe.exec(text)) !== null) {
    fencedBodies.push(fm[1].trim());
  }
  for (let i = fencedBodies.length - 1; i >= 0; i--) {
    const inner = fencedBodies[i];
    const m = inner.match(/@start[\w]*[\s\S]*?@end[\w]*/i);
    if (m) return m[0].trim();
    if (inner.includes('@start')) return inner;
  }
  const nakedRe = /@start[\w]*[\s\S]*?@end[\w]*/gi;
  let lastNaked = null;
  let nm;
  while ((nm = nakedRe.exec(text)) !== null) {
    lastNaked = nm[0];
  }
  if (lastNaked) return lastNaked.trim();
  return text.trim();
}

/**
 * 如果开启国内高校模式，自动在 @startuml 后加入必须的配置
 * 只做完全安全的事情：
 * 1. 把 @startuml 变成 @startuml activity（关键！）
 * 2. 插入 skinparam 配置（如果没有的话）
 * 3. 只替换完整独立的 start/stop（避免误伤）
 * 注意：@startchen 语法不需要转换，保持原样
 */
function applyChinaUnivModeIfNeeded(source, cfg, ctx = {}) {
  const safeCfg = { ...DEFAULT_AGENT, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  if (!safeCfg.chinaUnivMode) return source;

  const intent = ctx.intent || 'other';
  const userText = String(ctx.userText || '');
  if (!shouldApplyChinaUnivPostProcess(intent, userText)) return source;

  // @startchen 语法有自己的规则，不需要应用国内高校模式转换
  if (source.includes('@startchen')) {
    return source;
  }
  
  let result = source;
  
  // 1. 先把 @startuml 变成 @startuml activity（避免报错 "Cannot find if"）
  result = result.replace(/@startuml(\s*)/i, '@startuml activity$1');
  
  // 2. 插入/确保 skinparam 配置存在
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
  
  // 3. 安全替换独立的 start → :开始;（完全匹配、只替换独立单词）
  // 避免误伤其他可能包含 "start" 的内容
  result = result.replace(/^\s*start\s*$/gm, ':开始;');
  result = result.replace(/^\s*Start\s*$/gm, ':开始;');
  result = result.replace(/^\s*START\s*$/gm, ':开始;');
  
  // 4. 安全替换独立的 stop → :结束;（完全匹配、只替换独立单词）
  result = result.replace(/^\s*stop\s*$/gm, ':结束;');
  result = result.replace(/^\s*Stop\s*$/gm, ':结束;');
  result = result.replace(/^\s*STOP\s*$/gm, ':结束;');
  
  return result;
}

async function plantumlRenderCheck(source, options = ['-tpng']) {
  if (!apiBase) throw new Error('PlantUML 服务未就绪');
  const res = await fetch(`${apiBase}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ source, options }),
  });
  const err = res.headers.get('x-plantuml-diagram-error');
  const errLine = res.headers.get('x-plantuml-diagram-error-line');
  const buf = Buffer.from(await res.arrayBuffer());
  const diagramError = Boolean(err && err.trim());
  const ok = res.ok && !diagramError && buf.length > 0;
  let errText = '';
  if (!res.ok) errText = `HTTP ${res.status}`;
  if (diagramError) errText = [errText, err, errLine ? `line: ${errLine}` : ''].filter(Boolean).join('\n');
  if (!diagramError && res.ok && buf.length === 0) errText = '空响应体';
  return { ok, buffer: buf, errText: errText || undefined };
}

async function plantumlRenderCheckWithOptionalSvg(source) {
  const png = await plantumlRenderCheck(source, ['-tpng']);
  const dual = process.env.UML_MASTER_DUAL_RENDER === '1' || process.env.UML_MASTER_DUAL_RENDER === 'true';
  if (!png.ok) return { ...png, dualSvgSkipped: !dual };
  if (!dual) return { ...png, dualSvgSkipped: true };
  const svg = await plantumlRenderCheck(source, ['-tsvg']);
  if (!svg.ok) {
    return {
      ...png,
      dualSvgWarning: svg.errText || '未知',
    };
  }
  return { ...png, dualSvgOk: true };
}

function extractApproxLineFromPlantumlErr(errText) {
  const m = /line:\s*(\d+)/i.exec(String(errText || ''));
  return m ? Number(m[1]) : null;
}

function sliceSourceNearLine(source, lineNo, contextLines = 20) {
  if (!lineNo || lineNo < 1) return '';
  const lines = String(source || '').split(/\r?\n/);
  const i = lineNo - 1;
  if (i < 0 || i >= lines.length) return '';
  const from = Math.max(0, i - contextLines);
  const to = Math.min(lines.length, i + contextLines + 1);
  return lines.slice(from, to).map((l, idx) => `${from + idx + 1}: ${l}`).join('\n');
}

function foldSourceMiddle(source, maxHead = 4000, maxTail = 4000) {
  const s = String(source || '');
  if (s.length <= maxHead + maxTail + 120) return s;
  const omitted = s.length - maxHead - maxTail;
  return `${s.slice(0, maxHead)}\n\n/* …中间已省略约 ${omitted} 字符… */\n\n${s.slice(-maxTail)}`;
}

function buildAgentRetryUserContent({ isProject, round, lastErr, source, dupTail }) {
  const head = isProject
    ? '上一版源码经 PlantUML 校验未通过，请结合项目上下文修订后，再次输出完整源码（整段替换）。'
    : '上一版源码经 PlantUML 校验未通过，请根据错误信息修订后，再次输出完整源码（整段替换）。';
  const hint = PLANTUML_RETRY_HINT;
  if (round < 2) {
    return `${head}${hint}${dupTail}\n\n--- 错误 ---\n${lastErr}\n\n--- 当前源码 ---\n${source}`;
  }
  const lineNo = extractApproxLineFromPlantumlErr(lastErr);
  const near = lineNo ? sliceSourceNearLine(source, lineNo, 22) : '';
  const folded = foldSourceMiddle(source);
  return `${head}${hint}${dupTail}

--- 结构化错误摘要（本地） ---
行号提示: ${lineNo ?? '未知'}；请优先修正该行附近语法。

--- 错误原文 ---
${lastErr}

${near ? `--- 源码片段（错误行 ±N）---\n${near}\n` : ''}
--- 完整源码（折叠参考；输出须为全新完整稿，勿只改片段）---
${folded}`;
}

/** @param {unknown} e */
function flattenFetchRelatedMessage(e) {
  const parts = [];
  const seen = new Set();
  const push = (s) => {
    const t = String(s || '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      parts.push(t);
    }
  };
  if (e instanceof AggregateError && Array.isArray(e.errors)) {
    push(e.message);
    for (const sub of e.errors) {
      if (sub && typeof sub === 'object' && 'message' in sub) push(sub.message);
      else push(sub);
    }
  } else {
    let cur = e;
    for (let depth = 0; cur != null && depth < 8; depth++) {
      if (typeof cur === 'object' && 'message' in cur) push(cur.message);
      else if (typeof cur === 'string') push(cur);
      if (cur instanceof AggregateError && Array.isArray(cur.errors)) {
        for (const sub of cur.errors) {
          if (sub && typeof sub === 'object' && 'message' in sub) push(sub.message);
          else push(sub);
        }
        break;
      }
      cur = cur && typeof cur === 'object' && 'cause' in cur ? cur.cause : null;
    }
  }
  return parts.join(' | ') || '未知错误';
}

/** @param {string} msg */
function isTransientDeepseekFailure(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    /fetch failed|failed to fetch|networkerror|econnreset|etimedout|econnrefused|enotfound|eai_again|socket hang up|und_err|aborted|reset by peer|tls|ssl|certificate|eof/i.test(
      m
    ) || /timeout|timed out/i.test(m)
  );
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function deepseekChat(config, messages, options = {}) {
  const base = String(config.baseUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) throw new Error('未配置 Base URL');
  const url = `${base}/v1/chat/completions`;
  const key = (config.apiKey || '').trim();
  if (!key) throw new Error('未配置 DeepSeek API Key');

  const temperature =
    typeof options.temperature === 'number' && Number.isFinite(options.temperature)
      ? Math.min(1.5, Math.max(0, options.temperature))
      : 0.2;

  const maxAttempts = Math.max(1, Math.min(6, Number(options.fetchMaxAttempts) || 4));
  const body = JSON.stringify({
    model: config.model,
    messages,
    temperature,
  });

  let lastFlat = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(t);

      if (!res.ok) {
        const t2 = await res.text();
        const flatHttp = `HTTP ${res.status}: ${t2.slice(0, 800)}`;
        lastFlat = flatHttp;
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(res.status);
        if (retryable && attempt < maxAttempts) {
          const delay = Math.min(12_000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
          await sleepMs(delay);
          continue;
        }
        throw new Error(`DeepSeek 请求失败 ${flatHttp}`);
      }

      const j = await res.json();
      const content = j.choices?.[0]?.message?.content;
      if (!content) throw new Error('DeepSeek 响应无有效内容');
      return String(content);
    } catch (e) {
      clearTimeout(t);
      const name = e && typeof e === 'object' ? e.name : '';
      const flat = flattenFetchRelatedMessage(e);
      lastFlat = flat;

      if (name === 'AbortError' || /\babort(ed)?\b/i.test(flat)) {
        throw new Error('DeepSeek 请求超时（120 秒）');
      }

      const transient =
        isTransientDeepseekFailure(flat) ||
        (e && typeof e === 'object' && isTransientDeepseekFailure(String(e.cause?.message || '')));

      if (transient && attempt < maxAttempts) {
        const delay = Math.min(12_000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
        await sleepMs(delay);
        continue;
      }

      const hint =
        '请检查：1) Base URL（例如 https://api.deepseek.com）是否可达 2) 系统代理 / VPN / 防火墙是否拦截 3) API Key 是否有效 4) 若在公司网络，可尝试切换网络或配置系统代理。';
      throw new Error(`${flat}\n\n${hint}`);
    }
  }

  throw new Error(lastFlat || 'DeepSeek 请求失败');
}

async function runAgentPipeline(userText) {
  const cfg = loadAgentConfig();
  const logs = [];
  const ut = String(userText || '');
  const intent = classifyDiagramIntent(ut, cfg.chinaUnivMode);
  const kbPath = findKnowledgeBasePath();
  const inj = buildKnowledgeInjection({
    kbPath: kbPath || '',
    intent,
    userText: ut,
    maxChars: 40000,
    jarLabel: resolvePlantumlJarLabelForPrompt(),
  });
  const kbPayload = {
    l0: inj.l0,
    kbExcerpt: inj.kbExcerpt,
    selectedTitles: inj.selectedTitles,
    intent,
  };
  const system = buildAgentSystemPrompt(kbPayload, cfg);
  logs.push(
    `[metrics] ${JSON.stringify({
      mode: 'simple',
      intent,
      kbChars: inj.kbExcerpt.length,
      kbFallback: inj.fallback,
      kbTruncated: inj.truncated,
    })}`
  );
  const maxExtra = cfg.maxRetries;
  const maxRounds = 1 + maxExtra;

  let source = '';
  let lastErr = '';
  let lastExtracted = '';
  let noRepeatHint = false;

  for (let round = 0; round < maxRounds; round++) {
    const dupTail = noRepeatHint
      ? '\n\n【再次强调】你上一版输出的 PlantUML 与「当前源码」逐字相同，属于无效修复；必须实质性改写（尤其错误信息中的行号附近），禁止重复同一 fenced 块。'
      : '';
    noRepeatHint = false;

    const userContent =
      round === 0
        ? `用户需求：\n${userText}\n\n请输出完整可渲染的 PlantUML 源码。`
        : buildAgentRetryUserContent({ isProject: false, round, lastErr, source, dupTail });

    const raw = await deepseekChat(
      cfg,
      [{ role: 'system', content: system }, { role: 'user', content: userContent }],
      { temperature: round > 0 ? 0.58 : 0.2 }
    );
    let extracted = extractPlantumlFromModelText(raw);
    extracted = applyChinaUnivModeIfNeeded(extracted, cfg, { intent, userText: ut });
    if (round > 0 && extracted === lastExtracted && lastExtracted.length > 20) {
      noRepeatHint = true;
      logs.push(`第 ${round + 1} 轮：提取结果与上一轮完全相同（${extracted.length} 字符），下一轮将加重「禁止重复」提示并提高采样温度。`);
    }
    lastExtracted = extracted;
    source = extracted;
    if (!source.includes('@start') || !source.includes('@end')) {
      lastErr = '模型输出中未找到 @start...@end 结构的 PlantUML';
      logs.push(`第 ${round + 1} 轮：${lastErr}`);
      if (round === maxRounds - 1) {
        return { ok: false, source, error: lastErr, logs };
      }
      continue;
    }

    logs.push(`第 ${round + 1} 轮：已生成 ${source.length} 字符，正在本地 PlantUML 校验…`);
    const { ok, errText, dualSvgOk, dualSvgWarning } = await plantumlRenderCheckWithOptionalSvg(source);
    if (ok) {
      if (dualSvgWarning) logs.push(`第 ${round + 1} 轮：PNG 通过；可选 SVG 未通过（仅记录）：${dualSvgWarning}`);
      logs.push(`第 ${round + 1} 轮：校验通过${dualSvgOk ? '（含可选 SVG）' : ''}`);
      logs.push(
        `[metrics] ${JSON.stringify({ mode: 'simple', roundOk: round + 1, dualSvgOk: Boolean(dualSvgOk), dualSvgWarning: Boolean(dualSvgWarning) })}`
      );
      return { ok: true, source, logs };
    }
    lastErr = errText || '未知渲染错误';
    logs.push(`第 ${round + 1} 轮：校验失败 — ${lastErr}`);
    if (round === maxRounds - 1) {
      return { ok: false, source, error: lastErr, logs };
    }
  }

  return { ok: false, source, error: lastErr || '已达最大重试次数', logs };
}

/**
 * 单一入口：无项目根 / 需求未体现读仓库意图 → runAgentPipeline；否则 → runAgentPipelineWithProject。
 * @param {string} ignoreGlobsText
 */
async function runAgentPipelineAdaptive(userText, projectRootFromUi, ignoreGlobsText) {
  const ut = String(userText || '').trim();
  const rootFromUi = String(projectRootFromUi || '').trim();
  const root = rootFromUi || String(loadAgentConfig().lastProjectRoot || '').trim();

  if (!root) {
    const r = await runAgentPipeline(ut);
    return {
      ...r,
      logs: ['[routing] 未选择项目目录 → 仅按需求生成（不含仓库文件上下文）。', ...(r.logs || [])],
    };
  }

  if (!wantsProjectCodeContext(ut)) {
    const r = await runAgentPipeline(ut);
    return {
      ...r,
      logs: [
        '[routing] 已选项目目录，但需求未出现「读仓库 / 代码路径 / 依赖…」等明确信号 → 自动采用仅按需求生成，避免无关任务扫描仓库。（可在需求中写明「根据本项目源码…」等以启用结合项目。）',
        ...(r.logs || []),
      ],
    };
  }

  const r = await runAgentPipelineWithProject(ut, root, ignoreGlobsText);
  return {
    ...r,
    logs: [`[routing] 结合项目目录生成：${root}`, ...(r.logs || [])],
  };
}

async function runAgentPipelineWithProject(userText, projectRoot, ignoreGlobsText) {
  const root = String(projectRoot || '').trim();
  if (!root) return { ok: false, error: '未选择项目目录', logs: [] };

  const cfg = loadAgentConfig();
  const rawGlobs =
    ignoreGlobsText !== undefined && ignoreGlobsText !== null ? String(ignoreGlobsText) : cfg.projectIgnoreGlobs || '';
  const userPatterns = parseIgnoreGlobLines(rawGlobs);

  let manifest;
  try {
    manifest = collectProjectManifest(root, { userIgnoreGlobs: userPatterns });
  } catch (e) {
    return { ok: false, error: String(e.message || e), logs: [] };
  }

  const { text: manifestJsonl, truncated: manifestTruncated, lineCount: manifestLineCount, totalFiles } =
    formatManifestJsonl(manifest.files, 2200);

  const plannerUser = [
    '【制图目标】',
    String(userText || '').trim(),
    '',
    '【仓库文件清单 JSONL（path 必须在输出的 paths 中原样出现；若清单截断则仅从下列 path 中选）】',
    manifestJsonl,
    manifestTruncated ? `\n… 另有约 ${Math.max(0, totalFiles - manifestLineCount)} 条未列出` : '',
    '',
    '只输出 JSON：{"paths":[],"rationale":"","diagram_guess":"","risk_notes":""}。paths 最多 35 项；后两字段可空字符串。勿使用 markdown 围栏。',
  ].join('\n');

  const logs = [
    `项目目录：${root}`,
    `索引：约 ${manifest.stats.fileCount} 个可分析文本文件；密钥模式已跳过 ${manifest.stats.skippedSecrets} 条；自定义忽略 ${manifest.stats.skippedUserIgnore} 条；.gitignore 近似跳过 ${manifest.stats.skippedGitignore} 条。`,
  ];
  if (manifest.stats.hitCap) logs.push('提示：已达本地清单条目上限，超大仓库可能不完整。');

  const validPaths = new Set(manifest.files.map((f) => f.path));
  let rationale = '';
  let diagramGuess = '';
  let riskNotes = '';
  let selectedPaths = [];
  let plannerFallback = false;

  try {
    const plannerRaw = await deepseekChat(cfg, [
      { role: 'system', content: PROJECT_PLANNER_SYSTEM },
      { role: 'user', content: plannerUser },
    ]);
    const pr = parsePlannerPaths(plannerRaw);
    rationale = pr.rationale || '';
    diagramGuess = pr.diagramGuess || '';
    riskNotes = pr.riskNotes || '';
    selectedPaths = (pr.paths || []).filter((p) => validPaths.has(p)).slice(0, 35);
    logs.push(`规划阶段：模型选出 ${selectedPaths.length} 个文件路径。`);
    if (!selectedPaths.length && (pr.paths || []).length > 0) {
      logs.push('规划返回的路径均不在本地清单中，将回退启发式。');
      plannerFallback = true;
    }
  } catch (e) {
    logs.push(`规划阶段 DeepSeek 不可用或失败：${String(e.message || e)}；已改用本地启发式。`);
    selectedPaths = heuristicPrioritizedPaths(manifest.files, 35);
    plannerFallback = true;
  }

  if (!selectedPaths.length) {
    selectedPaths = heuristicPrioritizedPaths(manifest.files, 35);
    logs.push('规划结果为空，已改用本地启发式选文件。');
    plannerFallback = true;
  }

  logs.push(`[metrics] ${JSON.stringify({ mode: 'project', plannerFallback })}`);

  const { header, footer } = buildProjectUserBlockParts({
    root,
    userGoal: String(userText || '').trim(),
    manifestLineCount,
    manifestTruncated,
    skippedSecrets: manifest.stats.skippedSecrets,
    plannerRationale: rationale,
    diagramGuess,
    riskNotes,
    shortTree: manifest.shortTreeLines,
  });

  let budgetChars = computeBundleCharBudget(`${header}\n`, footer);
  budgetChars = Math.max(14_000, Math.min(budgetChars, 400_000));

  const bundle = buildFileBundle(root, selectedPaths, {
    perFileMaxChars: 76_000,
    totalMaxChars: budgetChars,
  });
  if (bundle.notes.length) logs.push(`文件读取：${bundle.notes.slice(0, 5).join('；')}`);

  const firstUserBlock = assembleUserBlock(header, bundle.text, footer);

  const limitCheck = checkAssembledContextLimit(firstUserBlock);
  if (!limitCheck.ok) {
    logs.push(`首轮消息粗算约 ${limitCheck.estimatedTokens} tokens。`);
    return { ok: false, error: limitCheck.message, logs, source: '' };
  }
  logs.push(
    `首轮用户消息粗算约 ${estimateTokens(firstUserBlock)} tokens（≈字符/${CHARS_PER_TOKEN_EST}）；正文含 ${bundle.usedPaths.length} 个文件。`
  );

  const ut = String(userText || '');
  const intentText = diagramGuess ? `${ut}\n${diagramGuess}` : ut;
  const intent = classifyDiagramIntent(intentText, cfg.chinaUnivMode);
  const kbPath = findKnowledgeBasePath();
  const inj = buildKnowledgeInjection({
    kbPath: kbPath || '',
    intent,
    userText: intentText,
    maxChars: 40000,
    jarLabel: resolvePlantumlJarLabelForPrompt(),
  });
  const kbPayload = {
    l0: inj.l0,
    kbExcerpt: inj.kbExcerpt,
    selectedTitles: inj.selectedTitles,
    intent,
  };
  const system = buildAgentSystemPromptForProject(kbPayload, cfg);
  logs.push(
    `[metrics] ${JSON.stringify({
      mode: 'project_render',
      intent,
      kbChars: inj.kbExcerpt.length,
      kbFallback: inj.fallback,
      kbTruncated: inj.truncated,
    })}`
  );
  const maxExtra = cfg.maxRetries;
  const maxRounds = 1 + maxExtra;

  let source = '';
  let lastErr = '';
  let lastExtracted = '';
  let noRepeatHint = false;

  for (let round = 0; round < maxRounds; round++) {
    const dupTail = noRepeatHint
      ? '\n\n【再次强调】你上一版输出的 PlantUML 与「当前源码」逐字相同，属于无效修复；必须实质性改写报错行附近（见错误中的 line），禁止重复同一 fenced 块。'
      : '';
    noRepeatHint = false;

    const userContent =
      round === 0
        ? firstUserBlock
        : buildAgentRetryUserContent({ isProject: true, round, lastErr, source, dupTail });

    const raw = await deepseekChat(
      cfg,
      [{ role: 'system', content: system }, { role: 'user', content: userContent }],
      { temperature: round > 0 ? 0.58 : 0.2 }
    );
    let extracted = extractPlantumlFromModelText(raw);
    extracted = applyChinaUnivModeIfNeeded(extracted, cfg, { intent, userText: intentText });
    if (round > 0 && extracted === lastExtracted && lastExtracted.length > 20) {
      noRepeatHint = true;
      logs.push(`第 ${round + 1} 轮：提取结果与上一轮完全相同（${extracted.length} 字符），下一轮将加重「禁止重复」提示并提高采样温度。`);
    }
    lastExtracted = extracted;
    source = extracted;
    if (!source.includes('@start') || !source.includes('@end')) {
      lastErr = '模型输出中未找到 @start...@end 结构的 PlantUML';
      logs.push(`第 ${round + 1} 轮：${lastErr}`);
      if (round === maxRounds - 1) {
        return { ok: false, source, error: lastErr, logs };
      }
      continue;
    }

    logs.push(`第 ${round + 1} 轮：已生成 ${source.length} 字符，正在本地 PlantUML 校验…`);
    const { ok, errText, dualSvgOk, dualSvgWarning } = await plantumlRenderCheckWithOptionalSvg(source);
    if (ok) {
      if (dualSvgWarning) logs.push(`第 ${round + 1} 轮：PNG 通过；可选 SVG 未通过（仅记录）：${dualSvgWarning}`);
      logs.push(`第 ${round + 1} 轮：校验通过${dualSvgOk ? '（含可选 SVG）' : ''}`);
      logs.push(
        `[metrics] ${JSON.stringify({ mode: 'project_render', roundOk: round + 1, dualSvgOk: Boolean(dualSvgOk), dualSvgWarning: Boolean(dualSvgWarning) })}`
      );
      return { ok: true, source, logs };
    }
    lastErr = errText || '未知渲染错误';
    logs.push(`第 ${round + 1} 轮：校验失败 — ${lastErr}`);
    if (round === maxRounds - 1) {
      return { ok: false, source, error: lastErr, logs };
    }
  }

  return { ok: false, source, error: lastErr || '已达最大重试次数', logs };
}

function extractStudioArchFromModelText(raw) {
  const t = String(raw || '');
  const m = t.match(/@studio-arch[\s\S]*?@endstudio-arch/i);
  return m ? m[0].trim() : '';
}

async function runArchitectureArchDraftAgent(userText, projectRoot, ignoreGlobsText) {
  const root = String(projectRoot || '').trim();
  if (!root) return { ok: false, error: '未选择项目目录', logs: [] };

  const cfg = loadAgentConfig();
  const rawGlobs =
    ignoreGlobsText !== undefined && ignoreGlobsText !== null ? String(ignoreGlobsText) : cfg.projectIgnoreGlobs || '';
  const userPatterns = parseIgnoreGlobLines(rawGlobs);

  let manifest;
  try {
    manifest = collectProjectManifest(root, { userIgnoreGlobs: userPatterns });
  } catch (e) {
    return { ok: false, error: String(e.message || e), logs: [] };
  }

  const { text: manifestJsonl, truncated: manifestTruncated, lineCount: manifestLineCount, totalFiles } =
    formatManifestJsonl(manifest.files, 1800);

  const archKb = findArchKnowledgeBasePath();
  const inj = buildKnowledgeInjection({
    kbPath: archKb || '',
    intent: 'arch_static',
    userText: String(userText || ''),
    maxChars: 16_000,
    jarLabel: '',
  });
  const kbPayload = {
    l0: inj.l0,
    kbExcerpt: inj.kbExcerpt,
    selectedTitles: inj.selectedTitles,
    intent: 'arch_static',
  };
  const system = buildArchAgentSystemPrompt(kbPayload, cfg);
  const userBlock = [
    '【项目根】',
    root,
    '',
    '【文件清单 JSONL（path 为唯一可信路径）】',
    manifestJsonl,
    manifestTruncated ? `\n… 另有约 ${Math.max(0, totalFiles - manifestLineCount)} 条未列出` : '',
    '',
    '【用户需求】',
    String(userText || '').trim(),
    '',
    '请只输出一段：以 @studio-arch 开头、@endstudio-arch 结尾的 YAML 块，勿输出其它解释。',
  ].join('\n');

  const logs = [
    `模式：静态架构草稿（arch_static）`,
    `索引约 ${manifest.stats.fileCount} 个文本文件条目。`,
    `[metrics] ${JSON.stringify({ mode: 'arch_draft', kbChars: inj.kbExcerpt.length, kbFallback: inj.fallback })}`,
  ];

  const raw = await deepseekChat(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: userBlock },
  ]);
  const source = extractStudioArchFromModelText(raw);
  if (!source) {
    logs.push(`模型原始前 500 字：\n${raw.slice(0, 500)}`);
    return { ok: false, error: '模型未返回 @studio-arch … @endstudio-arch 块', logs };
  }
  logs.push(`已提取 @studio-arch 块，${source.length} 字符。`);
  return { ok: true, source, logs };
}

/** 优先：捆绑 JRE（安装版）→ JAVA_HOME → PATH 上的 java */
function resolveJavaExecutable() {
  if (process.platform === 'win32') {
    if (app.isPackaged) {
      const bundled = join(process.resourcesPath, 'jre', 'bin', 'java.exe');
      if (existsSync(bundled)) return bundled;
    } else {
      const dev = join(__dirname, 'vendor', 'jre', 'bin', 'java.exe');
      if (existsSync(dev)) return dev;
    }
  }

  const home = process.env.JAVA_HOME;
  if (home) {
    const winJava = join(home, 'bin', 'java.exe');
    if (existsSync(winJava)) return winJava;
    const nixJava = join(home, 'bin', 'java');
    if (existsSync(nixJava)) return nixJava;
  }

  return 'java';
}

function findPlantumlJar() {
  const envPath = process.env.PLANTUML_JAR;
  if (envPath && existsSync(envPath)) return envPath;

  // 优先：项目内部 vendor/plantuml/（开发环境，独立化改造）
  const vendorJar = join(__dirname, 'vendor', 'plantuml');
  if (existsSync(vendorJar)) {
    const jars = readdirSync(vendorJar).filter((f) => f.startsWith('plantuml-') && f.endsWith('.jar'));
    if (jars.length) {
      jars.sort((a, b) => statSync(join(vendorJar, b)).mtimeMs - statSync(join(vendorJar, a)).mtimeMs);
      return join(vendorJar, jars[0]);
    }
  }

  // 打包后的 resources/plantuml/
  const resLibs = join(process.resourcesPath || '', 'plantuml');
  if (existsSync(resLibs)) {
    const jars = readdirSync(resLibs).filter((f) => f.startsWith('plantuml-') && f.endsWith('.jar'));
    if (jars.length) {
      jars.sort((a, b) => statSync(join(resLibs, b)).mtimeMs - statSync(join(resLibs, a)).mtimeMs);
      return join(resLibs, jars[0]);
    }
  }

  return null;
}

function forwardLog(line) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('studio:server-log', line);
  }
}

async function startPicoWeb() {
  const jar = findPlantumlJar();
  if (!jar) {
    await dialog.showErrorBox(
      '未找到 PlantUML JAR',
      '安装包中应包含 plantuml JAR。开发环境请将 plantuml-*.jar 放入 vendor/plantuml/，\n或设置环境变量 PLANTUML_JAR 指向 JAR 文件。'
    );
    quitAppWithoutConfirm();
    return;
  }

  const javaExe = resolveJavaExecutable();

  return new Promise((resolve, reject) => {
    javaChild = spawn(javaExe, ['-Djava.awt.headless=true', '-jar', jar, '--http-server:0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const rl = createInterface({ input: javaChild.stderr });
    let settled = false;

    const onLine = (line) => {
      forwardLog(line);
      const m = /webPort=(\d+)/.exec(line);
      if (m && !settled) {
        settled = true;
        const port = m[1];
        apiBase = `http://127.0.0.1:${port}`;
        rl.close();
        resolve(apiBase);
      }
    };

    rl.on('line', onLine);

    javaChild.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `${err.message}\n\n可执行文件: ${javaExe}\n若开发环境未准备 JRE，请运行 npm run prepare:jre，或安装 JDK 并加入 PATH。`
          )
        );
      }
    });

    javaChild.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`PlantUML 进程退出 code=${code}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('等待 PicoWeb 端口超时（未在 stderr 看到 webPort=）'));
      }
    }, 60000);
  });
}

/**
 * 停止 PlantUML PicoWeb（Java）子进程。
 * Windows 上使用 taskkill /T /F 结束进程树，避免残留占用文件句柄导致后续 electron-builder 失败。
 */
function stopPicoWeb() {
  const child = javaChild;
  javaChild = null;
  apiBase = null;
  if (!child || child.killed) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32' && pid) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: 'ignore', timeout: 12000 });
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          if (child && !child.killed) child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2500);
    }
  } catch {
    /* ignore */
  }
}

function showExitConfirmDialog() {
  const parent =
    (mainWindow && !mainWindow.isDestroyed() && mainWindow) ||
    BrowserWindow.getFocusedWindow() ||
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  return dialog.showMessageBox(parent && !parent.isDestroyed() ? parent : undefined, {
    type: 'question',
    buttons: ['退出', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '确认退出',
    message: '确定要退出 PlantUML 本地工作室吗？',
    detail: '退出后将关闭内置预览服务并结束相关进程。',
    noLink: true,
  });
}

/* ---------- 产出物暂存区（用户目录持久化） ---------- */

function stashRoot() {
  return join(app.getPath('userData'), 'output-stash');
}

function stashItemsDir() {
  return join(stashRoot(), 'items');
}

function stashManifestPath() {
  return join(stashRoot(), 'manifest.json');
}

function ensureStashDirs() {
  mkdirSync(stashItemsDir(), { recursive: true });
}

function readStashManifest() {
  ensureStashDirs();
  try {
    const p = stashManifestPath();
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return [];
  }
}

function writeStashManifest(items) {
  ensureStashDirs();
  writeFileSync(stashManifestPath(), JSON.stringify({ items }, null, 2), 'utf8');
}

function stashPngPath(id) {
  return join(stashItemsDir(), `${id}.png`);
}

function stashSvgPath(id) {
  return join(stashItemsDir(), `${id}.svg`);
}

function stashThumbPath(id) {
  return join(stashItemsDir(), `${id}.thumb.png`);
}

function stashPumlPath(id) {
  return join(stashItemsDir(), `${id}.puml`);
}

function removeStashFiles(id) {
  for (const p of [stashPngPath(id), stashSvgPath(id), stashThumbPath(id), stashPumlPath(id)]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

function pruneStashManifest() {
  let items = readStashManifest();
  const before = items.length;
  items = items.filter((m) => {
    if (!m?.id) return false;
    const ok =
      (m.kind === 'png' && existsSync(stashPngPath(m.id))) ||
      (m.kind === 'svg' && existsSync(stashSvgPath(m.id)));
    return ok;
  });
  if (items.length !== before) writeStashManifest(items);
  return items;
}

/* ---------- 错误日志归档（用户目录 JSONL，供「文件 → 查看错误日志」） ---------- */

const ERROR_LOG_MAX_FILE_BYTES = 1_200_000;

function studioErrorArchivePath() {
  return join(app.getPath('userData'), 'studio-error-archive.jsonl');
}

function appendStudioErrorArchive(record) {
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: String(record.kind || 'error').slice(0, 64),
      message: String(record.message || '').slice(0, 12000),
      detail: String(record.detail || '').slice(0, 24000),
    }) + '\n';
  try {
    appendFileSync(studioErrorArchivePath(), line, 'utf8');
    pruneStudioErrorArchiveIfHuge();
  } catch {
    /* ignore */
  }
}

function pruneStudioErrorArchiveIfHuge() {
  const p = studioErrorArchivePath();
  try {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.size <= ERROR_LOG_MAX_FILE_BYTES) return;
    const raw = readFileSync(p, 'utf8');
    const cut = raw.slice(-Math.floor(ERROR_LOG_MAX_FILE_BYTES * 0.85));
    writeFileSync(p, `…（文件过长已截断较早记录 @ ${new Date().toISOString()}）\n${cut}`, 'utf8');
  } catch {
    /* ignore */
  }
}

function readStudioErrorArchiveTail() {
  const p = studioErrorArchivePath();
  if (!existsSync(p)) return '（尚无错误归档）';
  const raw = readFileSync(p, 'utf8');
  const max = 160_000;
  return raw.length > max ? `…（仅显示最近约 ${max} 字符）\n${raw.slice(-max)}` : raw;
}

function buildStashListPayload() {
  const items = pruneStashManifest();
  const enriched = items.map((meta) => {
    let previewDataUrl = '';
    try {
      if (meta.kind === 'png') {
        const tp = stashThumbPath(meta.id);
        const full = stashPngPath(meta.id);
        const p = existsSync(tp) ? tp : full;
        if (existsSync(p)) {
          const b = readFileSync(p);
          previewDataUrl = `data:image/png;base64,${b.toString('base64')}`;
        }
      } else {
        const sp = stashSvgPath(meta.id);
        if (existsSync(sp)) {
          let s = readFileSync(sp, 'utf8');
          if (s.length > 40000) s = `${s.slice(0, 40000)}\n<!-- preview truncated -->`;
          previewDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
        }
      }
    } catch {
      /* ignore */
    }
    return { ...meta, previewDataUrl };
  });
  return { ok: true, items: enriched };
}

function registerIpcHandlers() {
  ipcMain.handle('studio:get-api-base', () => apiBase);

  ipcMain.handle('studio:clipboard-write-png', (_e, arrayBuffer) => {
    try {
      const lockGate = assertAgentLockBlocksFeature();
      if (lockGate) return { ok: false, error: lockGate.error };
      const buf = Buffer.from(new Uint8Array(arrayBuffer));
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return { ok: false, error: '无法从缓冲区创建图像' };
      clipboard.writeImage(img);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:render-png-buffer', async (_e, { source }) => {
    try {
      const { ok, buffer, errText } = await plantumlRenderCheck(String(source || ''), ['-tpng']);
      if (!ok) return { ok: false, error: errText || '渲染失败' };
      return { ok: true, base64: buffer.toString('base64') };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:agent-config-get', () => loadAgentConfig());

  ipcMain.handle('studio:agent-config-set', (_e, partial) => {
    const next = saveAgentConfig(partial || {});
    return { ok: true, config: next };
  });

  ipcMain.handle('studio:error-archive-append', (_e, payload) => {
    try {
      appendStudioErrorArchive({
        kind: payload?.kind,
        message: payload?.message,
        detail: payload?.detail,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:error-archive-read', () => {
    try {
      return { ok: true, text: readStudioErrorArchiveTail() };
    } catch (e) {
      return { ok: false, text: '', error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:agent-run', async (_e, payload) => {
    try {
      const p = payload != null && typeof payload === 'object' ? payload : { userText: payload };
      const text = String(p.userText ?? '').trim();
      const projectRoot = p.projectRoot != null ? String(p.projectRoot).trim() : '';
      const ignoreGlobsText = p.ignoreGlobsText;
      if (!text) return { ok: false, error: '请输入自然语言需求', logs: [] };
      const r = await runAgentPipelineAdaptive(text, projectRoot, ignoreGlobsText);
      if (r.ok && !isProEdition()) {
        setAgentSessionLock(r.source);
        return {
          ...r,
          locked: true,
          displaySource: buildLockedEditorPlaceholder(),
        };
      }
      if (r.ok && isProEdition()) {
        clearAgentSessionLock();
      }
      return { ...r, locked: false, displaySource: r.source };
    } catch (e) {
      const msg = String(e.message || e);
      return { ok: false, error: msg, logs: [msg] };
    }
  });

  ipcMain.handle('studio:pick-project-directory', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const r = await dialog.showOpenDialog(win || undefined, {
      properties: ['openDirectory'],
      title: '选择项目代码目录',
    });
    if (r.canceled || !r.filePaths?.length) return { ok: true, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  });

  ipcMain.handle('studio:project-summary', async (_e, { rootPath }) => {
    try {
      const { summary, stats } = buildProjectSummary(String(rootPath || '').trim());
      return { ok: true, summary, stats };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  /** 不调用 DeepSeek：按当前忽略规则 + 启发式选文件，粗算首轮将发送的 tokens */
  ipcMain.handle('studio:project-context-estimate', async (_e, { rootPath, userSample, ignoreGlobsText }) => {
    try {
      const root = String(rootPath || '').trim();
      if (!root) return { ok: false, error: '未选择项目目录' };
      const cfg = loadAgentConfig();
      const rawGlobs =
        ignoreGlobsText !== undefined && ignoreGlobsText !== null ? String(ignoreGlobsText) : cfg.projectIgnoreGlobs || '';
      const userPatterns = parseIgnoreGlobLines(rawGlobs);
      const manifest = collectProjectManifest(root, { userIgnoreGlobs: userPatterns });
      const mfLen = Math.min(2200, manifest.files.length);
      const { header, footer } = buildProjectUserBlockParts({
        root,
        userGoal: String(userSample || '').trim() || '（空需求占位）',
        manifestLineCount: mfLen,
        manifestTruncated: manifest.files.length > 2200,
        skippedSecrets: manifest.stats.skippedSecrets,
        plannerRationale: '',
        diagramGuess: '',
        riskNotes: '',
        shortTree: manifest.shortTreeLines,
      });
      let budgetChars = computeBundleCharBudget(`${header}\n`, footer);
      budgetChars = Math.max(14_000, Math.min(budgetChars, 400_000));
      const paths = heuristicPrioritizedPaths(manifest.files, 35);
      const bundle = buildFileBundle(root, paths, {
        perFileMaxChars: 76_000,
        totalMaxChars: budgetChars,
      });
      const full = assembleUserBlock(header, bundle.text, footer);
      const est = estimateTokens(full);
      return {
        ok: true,
        estimatedTokens: est,
        exceedsProductLimit: est > MAX_ASSEMBLED_USER_TOKENS,
        manifestFileEntries: manifest.stats.fileCount,
        bundleFileCount: bundle.usedPaths.length,
        skippedSecrets: manifest.stats.skippedSecrets,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:agent-run-project', async (_e, { userText, projectRoot, ignoreGlobsText }) => {
    try {
      const text = String(userText || '').trim();
      if (!text) return { ok: false, error: '请填写「自然语言需求」作为制图目标', logs: [] };
      const r = await runAgentPipelineWithProject(text, projectRoot, ignoreGlobsText);
      if (r.ok && !isProEdition()) {
        setAgentSessionLock(r.source);
        return {
          ...r,
          locked: true,
          displaySource: buildLockedEditorPlaceholder(),
        };
      }
      if (r.ok && isProEdition()) {
        clearAgentSessionLock();
      }
      return { ...r, locked: false, displaySource: r.source };
    } catch (e) {
      const msg = String(e.message || e);
      return { ok: false, error: msg, logs: [msg] };
    }
  });

  ipcMain.handle('studio:arch-render', async (_e, { projectRoot, ignoreGlobsText, archBlock }) => {
    try {
      const out = renderStudioArchSvg({
        projectRoot: String(projectRoot || '').trim(),
        ignoreGlobsText: String(ignoreGlobsText || ''),
        archBlock: String(archBlock || ''),
      });
      return { ok: true, svgText: out.svg, meta: out.meta };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:agent-arch-draft', async (_e, { userText, projectRoot, ignoreGlobsText }) => {
    try {
      const text = String(userText || '').trim();
      if (!text) return { ok: false, error: '请填写自然语言需求', logs: [] };
      if (!String(projectRoot || '').trim()) {
        return { ok: false, error: '未选择项目目录', logs: [] };
      }
      const r = await runArchitectureArchDraftAgent(text, projectRoot, ignoreGlobsText);
      return { ...r, locked: false, displaySource: r.source };
    } catch (e) {
      const msg = String(e.message || e);
      return { ok: false, error: msg, logs: [msg] };
    }
  });

  ipcMain.handle('studio:stash-list', () => buildStashListPayload());

  ipcMain.handle('studio:stash-add', (_e, payload) => {
    try {
      const lockGate = assertAgentLockBlocksFeature();
      if (lockGate) return lockGate;
      const kind = payload?.kind === 'svg' ? 'svg' : 'png';
      const id = randomUUID();
      ensureStashDirs();
      const labelRaw = payload?.label != null ? String(payload.label).trim() : '';
      const label =
        labelRaw ||
        `产出 ${new Date().toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })}`;
      const sourceText = payload?.sourceText != null ? String(payload.sourceText) : '';

      if (kind === 'png') {
        const buf = Buffer.from(new Uint8Array(payload?.arrayBuffer || []));
        if (!buf.length) return { ok: false, error: 'PNG 数据为空' };
        writeFileSync(stashPngPath(id), buf);
        try {
          const ni = nativeImage.createFromBuffer(buf);
          const thumb = ni.resize({ width: 168 });
          const tb = thumb.toPNG();
          if (tb && tb.length) writeFileSync(stashThumbPath(id), tb);
        } catch {
          /* 略过缩略图 */
        }
      } else {
        const svg = String(payload?.svgText || '');
        if (!svg.trim()) return { ok: false, error: 'SVG 内容为空' };
        writeFileSync(stashSvgPath(id), svg, 'utf8');
      }

      if (sourceText.length) {
        writeFileSync(stashPumlPath(id), sourceText.slice(0, 250000), 'utf8');
      }

      const items = readStashManifest();
      items.unshift({
        id,
        createdAt: Date.now(),
        kind,
        label,
        hasPuml: Boolean(sourceText.length),
      });
      writeStashManifest(items);
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:stash-remove', (_e, { ids }) => {
    try {
      const idSet = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
      if (!idSet.size) return { ok: false, error: '未选择条目' };
      const kept = readStashManifest().filter((m) => {
        if (idSet.has(m.id)) {
          removeStashFiles(m.id);
          return false;
        }
        return true;
      });
      writeStashManifest(kept);
      return { ok: true, removed: idSet.size };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:stash-get-full', (_e, { id }) => {
    try {
      const sid = String(id || '');
      if (!sid) return { ok: false, error: '缺少 id' };
      const items = readStashManifest();
      const meta = items.find((x) => x.id === sid);
      if (!meta) return { ok: false, error: '条目不存在' };
      if (meta.kind === 'png') {
        const p = stashPngPath(sid);
        if (!existsSync(p)) return { ok: false, error: '文件缺失' };
        const b = readFileSync(p);
        const pp = stashPumlPath(sid);
        let sourceText = '';
        if (existsSync(pp)) {
          try {
            sourceText = readFileSync(pp, 'utf8');
          } catch {
            sourceText = '';
          }
        }
        return {
          ok: true,
          kind: 'png',
          label: meta.label,
          createdAt: meta.createdAt,
          pngBase64: b.toString('base64'),
          sourceText,
        };
      }
      const sp = stashSvgPath(sid);
      if (!existsSync(sp)) return { ok: false, error: '文件缺失' };
      const svgText = readFileSync(sp, 'utf8');
      const pp = stashPumlPath(sid);
      let sourceText = '';
      if (existsSync(pp)) {
        try {
          sourceText = readFileSync(pp, 'utf8');
        } catch {
          sourceText = '';
        }
      }
      return {
        ok: true,
        kind: 'svg',
        label: meta.label,
        createdAt: meta.createdAt,
        svgText,
        sourceText,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:stash-copy', (_e, { id }) => {
    try {
      const lockGate = assertAgentLockBlocksFeature();
      if (lockGate) return lockGate;
      const sid = String(id || '');
      const items = readStashManifest();
      const meta = items.find((x) => x.id === sid);
      if (!meta) return { ok: false, error: '条目不存在' };
      if (meta.kind === 'png') {
        const p = stashPngPath(sid);
        if (!existsSync(p)) return { ok: false, error: '文件缺失' };
        const buf = readFileSync(p);
        const img = nativeImage.createFromBuffer(buf);
        if (img.isEmpty()) return { ok: false, error: '无法解析 PNG' };
        clipboard.writeImage(img);
        return { ok: true, mode: 'png' };
      }
      const sp = stashSvgPath(sid);
      if (!existsSync(sp)) return { ok: false, error: '文件缺失' };
      const svgText = readFileSync(sp, 'utf8');
      clipboard.writeText(svgText);
      return { ok: true, mode: 'svg' };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  /* ---------- 授权与激活 ---------- */

  /**
   * 收集本机设备信息用于生成 HW_ID
   */
  function collectDeviceInfo() {
    const info = {};
    try {
      // Windows MachineGuid
      try {
        const regOut = execSync(
          'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
          { timeout: 3000, encoding: 'utf8', windowsHide: true }
        );
        const m = regOut.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
        if (m) info.machineGuid = m[1].trim();
      } catch { /* ignore */ }

      // 系统盘卷序列号
      try {
        const volOut = execSync('vol C:', { timeout: 2000, encoding: 'utf8', windowsHide: true });
        const m = volOut.match(/序列号\s+(\S+)/i) || volOut.match(/Serial Number\s+(\S+)/i);
        if (m) info.diskSerial = m[1].trim();
      } catch { /* ignore */ }

      // 稳定网卡 MAC（排除虚拟适配器）
      try {
        const macOut = execSync(
          'wmic nic where "NetEnabled=true and AdapterTypeId=0 and not Name like \'%%Virtual%%\' and not Name like \'%%VMware%%\' and not Name like \'%%Hyper-V%%\'" get MACAddress',
          { timeout: 3000, encoding: 'utf8', windowsHide: true }
        );
        const lines = macOut.split('\n').map(l => l.trim()).filter(l => l && !l.includes('MACAddress'));
        if (lines.length > 0) info.macAddress = lines[0];
      } catch { /* ignore */ }
    } catch { /* ignore */ }
    return info;
  }

  function getLicenseVerificationContext() {
    const publicKey = resolveIssuerPublicKeyBuffer();
    if (!publicKey || !publicKey.length) return null;
    const devInfo = collectDeviceInfo();
    const hwId = generateHwId(devInfo);
    return { hwId, publicKey };
  }

  function isProEdition() {
    const ctx = getLicenseVerificationContext();
    if (!ctx) return false;
    const st = checkLicenseStatus(app.getPath('userData'), ctx);
    return st.activated === true;
  }

  function clearAgentSessionLock() {
    agentSessionLock = null;
  }

  function setAgentSessionLock(realSource) {
    const src = String(realSource || '');
    agentSessionLock = {
      active: true,
      realSource: src,
      digest: createHash('sha256').update(src, 'utf8').digest('hex'),
      since: Date.now(),
    };
  }

  function assertAgentLockBlocksFeature() {
    if (agentSessionLock?.active) {
      return {
        ok: false,
        error: '免费版智能生成内容已锁定：预览复制、导出与加入暂存已禁用。请完成支付解锁或激活专业版。',
      };
    }
    return null;
  }

  function resolvePayApiBase() {
    const raw = String(process.env.STUDIO_PAY_API_BASE || '').trim();
    return (raw || 'http://39.105.11.3:8848').replace(/\/$/, '');
  }

  ipcMain.handle('studio:license-get-device-info', () => {
    try {
      const devInfo = collectDeviceInfo();
      const hwId = generateHwId(devInfo);
      const deviceCode = generateDeviceCode(hwId);
      return {
        ok: true,
        hwId,
        shortHwId: shortHwId(hwId),
        deviceCode,
        collected: devInfo,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:license-get-status', () => {
    try {
      const ctx = getLicenseVerificationContext();
      const status = ctx ? checkLicenseStatus(app.getPath('userData'), ctx) : { activated: false, error: '未配置发行方公钥' };
      const edition = status.activated ? 'pro' : 'free';
      const agentLock = agentSessionLock?.active
        ? { active: true, digest: agentSessionLock.digest }
        : { active: false, digest: '' };
      const payApiBase = resolvePayApiBase();
      return { ok: true, ...status, edition, agentLock, payApiBase };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:license-activate', (_e, { licenseCode }) => {
    try {
      const code = String(licenseCode || '').trim();
      if (!code) return { ok: false, error: '请输入软件激活码' };

      // 获取本机 HW_ID
      const devInfo = collectDeviceInfo();
      const hwId = generateHwId(devInfo);

      const publicKey = resolveIssuerPublicKeyBuffer();
      if (!publicKey || !publicKey.length) {
        return { ok: false, error: '客户端未配置发行方公钥，无法接受激活。' };
      }

      // 校验激活码（含 Ed25519 签名）
      const result = validateLicenseCode(code, hwId, publicKey);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      // 持久化存储许可证
      const licenseData = {
        ...result.payload,
        license_code: code,
        activated_at: new Date().toISOString(),
        license_code_prefix: code.slice(0, 20) + '…',
      };
      writeLicense(app.getPath('userData'), licenseData);
      clearAgentSessionLock();

      return {
        ok: true,
        licenseMode: result.licenseMode,
        payload: result.payload,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:agent-lock-get', () => ({
    ok: true,
    active: Boolean(agentSessionLock?.active),
    digest: agentSessionLock?.digest || '',
  }));

  ipcMain.handle('studio:get-effective-plantuml-source', (_e, { editorText }) => {
    try {
      if (agentSessionLock?.active) {
        return { ok: true, source: agentSessionLock.realSource, locked: true };
      }
      return { ok: true, source: String(editorText || ''), locked: false };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:agent-lock-clear', () => {
    clearAgentSessionLock();
    return { ok: true };
  });

  ipcMain.handle('studio:agent-lock-user-override', (_e, { editorText }) => {
    clearAgentSessionLock();
    return { ok: true, editorText: String(editorText || '') };
  });

  ipcMain.handle('studio:pay-order-create', async () => {
    try {
      if (!agentSessionLock?.active) {
        return { ok: false, error: '当前无智能生成锁定内容，无需支付解锁' };
      }
      const ctx = getLicenseVerificationContext();
      if (!ctx?.hwId) return { ok: false, error: '无法获取设备指纹' };
      const base = resolvePayApiBase();
      const res = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hwId: ctx.hwId,
          contentDigest: agentSessionLock.digest,
          sku: 'agent_output_unlock',
          amount: 0.8,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        return { ok: false, error: j.error || `创建订单失败 HTTP ${res.status}` };
      }
      return { ok: true, orderId: j.orderId, payUrl: j.payUrl || '', mock: Boolean(j.mock) };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:pay-poll-status', async (_e, { orderId }) => {
    try {
      const id = String(orderId || '').trim();
      if (!id) return { ok: false, error: '缺少 orderId' };
      const base = resolvePayApiBase();
      const res = await fetch(`${base}/api/orders/${encodeURIComponent(id)}/status`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        return { ok: false, error: j.error || `HTTP ${res.status}` };
      }
      return { ok: true, status: j.status, unlockToken: j.unlockToken || null };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:pay-redeem-unlock', async (_e, { unlockToken }) => {
    try {
      if (!agentSessionLock?.active) {
        return { ok: false, error: '当前无锁定会话' };
      }
      const ctx = getLicenseVerificationContext();
      if (!ctx?.hwId) return { ok: false, error: '无法获取设备指纹' };
      const base = resolvePayApiBase();
      const res = await fetch(`${base}/api/unlock/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hwId: ctx.hwId,
          contentDigest: agentSessionLock.digest,
          unlockToken: String(unlockToken || '').trim(),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        return { ok: false, error: j.error || '校验失败' };
      }
      const plain = agentSessionLock.realSource;
      clearAgentSessionLock();
      return { ok: true, source: plain };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:pay-open-external', async (_e, { url }) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: '无效链接' };
    await shell.openExternal(u);
    return { ok: true };
  });

  /**
   * 临时方案：未接支付宝网关时，在客户端本地直接视为支付成功并解除智能生成锁定。
   * 正式接入支付宝后可改为由服务器验签下发 unlockToken；届时可移除此 IPC 或加环境变量开关。
   */
  ipcMain.handle('studio:pay-local-mock-complete', () => {
    try {
      if (!agentSessionLock?.active) {
        return { ok: false, error: '当前无锁定会话' };
      }
      const plain = agentSessionLock.realSource;
      clearAgentSessionLock();
      return { ok: true, source: plain };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:license-deactivate', () => {
    try {
      const p = getLicensePath(app.getPath('userData'));
      if (existsSync(p)) {
        writeFileSync(p, JSON.stringify({ deactivated: true, deactivated_at: new Date().toISOString() }, null, 2), 'utf8');
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
}

async function createWindow() {
  try {
    if (!apiBase) await startPicoWeb();
  } catch (e) {
    await dialog.showErrorBox('无法启动 PlantUML 服务', String(e.message || e));
    quitAppWithoutConfirm();
    return;
  }

  const winIcon = join(__dirname, 'assets', 'app-logo-512.png');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: 'PlantUML 本地工作室',
    ...(existsSync(winIcon) ? { icon: winIcon } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  await mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    if (skipExitConfirmOnce || exitConfirmed) {
      stopPicoWeb();
      return;
    }
    e.preventDefault();
    void showExitConfirmDialog().then(({ response }) => {
      if (response !== 0) return;
      exitConfirmed = true;
      stopPicoWeb();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (process.platform === 'darwin') exitConfirmed = false;
  });
}

app.commandLine.appendSwitch('disable-web-security');
  app.commandLine.appendSwitch('allow-file-access-from-files');

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob: file:; connect-src * http://127.0.0.1:* http://localhost:* https://cdn.jsdelivr.net https://api.deepseek.com file:; media-src *; font-src *; object-src *; child-src *; frame-src *; manifest-src *"
        ]
      }
    });
  });

  registerIpcHandlers();
  buildZhMenu();
  await createWindow();
});

app.on('window-all-closed', () => {
  stopPicoWeb();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  if (skipExitConfirmOnce || exitConfirmed) {
    stopPicoWeb();
    return;
  }
  e.preventDefault();
  void showExitConfirmDialog().then(({ response }) => {
    if (response !== 0) return;
    exitConfirmed = true;
    stopPicoWeb();
    app.quit();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
});
