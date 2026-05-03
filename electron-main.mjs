import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZhMenu } from './scripts/app-menu.mjs';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let javaChild = null;
let apiBase = null;

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
  const dir = dirname(agentConfigPath());
  mkdirSync(dir, { recursive: true });
  writeFileSync(agentConfigPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function findKnowledgeBasePath() {
  const candidates = [
    join(process.resourcesPath || '', 'kb', 'PlantUML-Agent-Knowledge-Base.md'),
    join(__dirname, '..', 'PlantUML-Agent-Knowledge-Base.md'),
    join(__dirname, 'PlantUML-Agent-Knowledge-Base.md'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function readKnowledgeBaseSnippet(maxChars = 16000) {
  const p = findKnowledgeBasePath();
  if (!p) return '';
  try {
    const s = readFileSync(p, 'utf8');
    return s.length <= maxChars ? s : `${s.slice(0, maxChars)}\n\n…（知识库已截断）`;
  } catch {
    return '';
  }
}

function buildAgentSystemPrompt(kbSnippet) {
  const kb = kbSnippet.trim();
  return [
    '你是 PlantUML 专家。用户会用自然语言描述要画的图。',
    '你必须只输出一段完整、可渲染的 PlantUML 源码，且必须包含 @startuml 与 @enduml（或当前任务要求的其它 @start...@end 对）。',
    '不要输出 Markdown 解释；若用代码块包裹，块内仍须是完整 PlantUML。',
    '若信息不足，在图内用 note 简要列出假设，仍给出可渲染的一版。',
    kb ? `\n下列为项目知识库摘录，请遵守其中的语法与约束：\n\n${kb}` : '',
  ].join('\n');
}

function buildAgentSystemPromptForProject(kbSnippet) {
  return `${buildAgentSystemPrompt(kbSnippet)}\n\n【项目模式】用户会提供本地工程目录的索引与「规划阶段」选出的若干源文件全文（受控长度）。请结合这些内容制图；若仍有信息缺口，在图中用 note 标明假设与未读到的模块。`;
}

/** 附在 PlantUML 校验失败后的修正轮 user 消息中，针对高频语法坑（如 title 行内字面 \\n） */
const PLANTUML_RETRY_HINT =
  '\n\n【PlantUML 常见修复】`title` 只能写单行标题；不要在 `title ...` 内写字面量 `\\n` 或拆成第二行。副标题请用 `caption ...`、`header` / `right header` 或 `floating note`。请输出与下面「当前源码」不完全相同、且可被 PlantUML 解析的完整源码。';

const PROJECT_PLANNER_SYSTEM = [
  '你是资深软件架构分析助手。',
  '用户会给出「制图目标」和一份 JSONL 文件清单（每行一个 JSON：path, bytes, ext, head）。',
  '你必须只输出一个 JSON 对象，不要使用 markdown 代码围栏。',
  'JSON 格式：{"paths":["相对路径1", ...], "rationale":"一句话说明为何选这些文件"}。',
  'paths 数组最多 35 个字符串，且每个必须原样来自清单中的 path 字段。',
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

async function deepseekChat(config, messages, options = {}) {
  const base = config.baseUrl.replace(/\/$/, '');
  const url = `${base}/v1/chat/completions`;
  const key = (config.apiKey || '').trim();
  if (!key) throw new Error('未配置 DeepSeek API Key');

  const temperature =
    typeof options.temperature === 'number' && Number.isFinite(options.temperature)
      ? Math.min(1.5, Math.max(0, options.temperature))
      : 0.2;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const t2 = await res.text();
    throw new Error(`DeepSeek 请求失败 HTTP ${res.status}: ${t2.slice(0, 800)}`);
  }
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 响应无有效内容');
  return String(content);
}

async function runAgentPipeline(userText) {
  const cfg = loadAgentConfig();
  const logs = [];
  const kb = readKnowledgeBaseSnippet();
  const system = buildAgentSystemPrompt(kb);
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
        : `上一版源码经 PlantUML 校验未通过，请根据错误信息修订后，再次输出完整源码（整段替换）。${PLANTUML_RETRY_HINT}${dupTail}\n\n--- 错误 ---\n${lastErr}\n\n--- 当前源码 ---\n${source}`;

    const raw = await deepseekChat(
      cfg,
      [{ role: 'system', content: system }, { role: 'user', content: userContent }],
      { temperature: round > 0 ? 0.58 : 0.2 }
    );
    const extracted = extractPlantumlFromModelText(raw);
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
    const { ok, errText } = await plantumlRenderCheck(source, ['-tpng']);
    if (ok) {
      logs.push(`第 ${round + 1} 轮：校验通过`);
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
    '只输出 JSON：{"paths":[],"rationale":""}。paths 最多 35 项。勿使用 markdown 围栏。',
  ].join('\n');

  const logs = [
    `项目目录：${root}`,
    `索引：约 ${manifest.stats.fileCount} 个可分析文本文件；密钥模式已跳过 ${manifest.stats.skippedSecrets} 条；自定义忽略 ${manifest.stats.skippedUserIgnore} 条；.gitignore 近似跳过 ${manifest.stats.skippedGitignore} 条。`,
  ];
  if (manifest.stats.hitCap) logs.push('提示：已达本地清单条目上限，超大仓库可能不完整。');

  const validPaths = new Set(manifest.files.map((f) => f.path));
  let rationale = '';
  let selectedPaths = [];

  try {
    const plannerRaw = await deepseekChat(cfg, [
      { role: 'system', content: PROJECT_PLANNER_SYSTEM },
      { role: 'user', content: plannerUser },
    ]);
    const pr = parsePlannerPaths(plannerRaw);
    rationale = pr.rationale || '';
    selectedPaths = (pr.paths || []).filter((p) => validPaths.has(p)).slice(0, 35);
    logs.push(`规划阶段：模型选出 ${selectedPaths.length} 个文件路径。`);
  } catch (e) {
    logs.push(`规划阶段 DeepSeek 不可用或失败：${String(e.message || e)}；已改用本地启发式。`);
    selectedPaths = heuristicPrioritizedPaths(manifest.files, 35);
  }

  if (!selectedPaths.length) {
    selectedPaths = heuristicPrioritizedPaths(manifest.files, 35);
    logs.push('规划结果为空，已改用本地启发式选文件。');
  }

  const { header, footer } = buildProjectUserBlockParts({
    root,
    userGoal: String(userText || '').trim(),
    manifestLineCount,
    manifestTruncated,
    skippedSecrets: manifest.stats.skippedSecrets,
    plannerRationale: rationale,
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

  const kb = readKnowledgeBaseSnippet();
  const system = buildAgentSystemPromptForProject(kb);
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
        : `上一版源码经 PlantUML 校验未通过，请结合项目上下文修订后，再次输出完整源码（整段替换）。${PLANTUML_RETRY_HINT}${dupTail}\n\n--- 错误 ---\n${lastErr}\n\n--- 当前源码 ---\n${source}`;

    const raw = await deepseekChat(
      cfg,
      [{ role: 'system', content: system }, { role: 'user', content: userContent }],
      { temperature: round > 0 ? 0.58 : 0.2 }
    );
    const extracted = extractPlantumlFromModelText(raw);
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
    const { ok, errText } = await plantumlRenderCheck(source, ['-tpng']);
    if (ok) {
      logs.push(`第 ${round + 1} 轮：校验通过`);
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

  const devLibs = join(__dirname, '..', 'plantuml-master', 'build', 'libs');
  if (existsSync(devLibs)) {
    const jars = readdirSync(devLibs).filter((f) => f.startsWith('plantuml-') && f.endsWith('.jar'));
    if (jars.length) {
      jars.sort((a, b) => statSync(join(devLibs, b)).mtimeMs - statSync(join(devLibs, a)).mtimeMs);
      return join(devLibs, jars[0]);
    }
  }

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
      '安装包中应包含 plantuml JAR。开发环境请将 plantuml-master 执行 Gradle 打出 JAR，\n或设置环境变量 PLANTUML_JAR。'
    );
    app.quit();
    return;
  }

  const javaExe = resolveJavaExecutable();

  return new Promise((resolve, reject) => {
    javaChild = spawn(javaExe, ['-jar', jar, '--http-server:0'], {
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

function stopPicoWeb() {
  if (javaChild && !javaChild.killed) {
    try {
      javaChild.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  javaChild = null;
  apiBase = null;
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

  ipcMain.handle('studio:agent-config-set', (_e, partial) => saveAgentConfig(partial || {}));

  ipcMain.handle('studio:agent-run', async (_e, { userText }) => {
    try {
      const text = String(userText || '').trim();
      if (!text) return { ok: false, error: '请输入自然语言需求', logs: [] };
      return await runAgentPipeline(text);
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
      return await runAgentPipelineWithProject(text, projectRoot, ignoreGlobsText);
    } catch (e) {
      const msg = String(e.message || e);
      return { ok: false, error: msg, logs: [msg] };
    }
  });

  ipcMain.handle('studio:stash-list', () => buildStashListPayload());

  ipcMain.handle('studio:stash-add', (_e, payload) => {
    try {
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
        return {
          ok: true,
          kind: 'png',
          label: meta.label,
          createdAt: meta.createdAt,
          pngBase64: b.toString('base64'),
        };
      }
      const sp = stashSvgPath(sid);
      if (!existsSync(sp)) return { ok: false, error: '文件缺失' };
      const svgText = readFileSync(sp, 'utf8');
      return {
        ok: true,
        kind: 'svg',
        label: meta.label,
        createdAt: meta.createdAt,
        svgText,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:stash-copy', (_e, { id }) => {
    try {
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
}

async function createWindow() {
  try {
    if (!apiBase) await startPicoWeb();
  } catch (e) {
    await dialog.showErrorBox('无法启动 PlantUML 服务', String(e.message || e));
    app.quit();
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
      sandbox: true,
    },
  });

  await mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  buildZhMenu();
  await createWindow();
});

app.on('window-all-closed', () => {
  stopPicoWeb();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopPicoWeb();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
});
