/**
 * KB 分层注入：按二级标题切块，按意图选章，控制总字符；无匹配时回退前缀截断。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} markdown
 * @returns {{ title: string, body: string }[]}
 */
export function splitKbByH2(markdown) {
  const md = String(markdown || '');
  const re = /^## (.+)$/gm;
  const matches = [...md.matchAll(re)];
  if (!matches.length) return [{ title: '全文', body: md }];
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : md.length;
    out.push({ title: matches[i][1].trim(), body: md.slice(start, end).trim() });
  }
  return out;
}

/** 从标题解析章节号：如 "12. 国内高校…" -> 12；附录 -> 100 */
function titleOrderKey(title) {
  const m = /^(\d+)\s*[\.．]/.exec(String(title || '').trim());
  if (m) return Number(m[1]);
  if (/^附录/i.test(title)) return 100;
  return 999;
}

/**
 * @param {DiagramIntent} intent
 * @returns {number[] | null} 优先按章节号包含；null 表示用打分全库
 */
function preferredSectionNums(intent) {
  switch (intent) {
    case 'chen_er':
      return [0, 1, 2, 3, 6, 11, 13];
    case 'activity_cn_univ':
      return [0, 1, 2, 4, 5, 6, 7, 11, 12];
    case 'sequence':
    case 'class_diag':
    case 'usecase':
    case 'state':
    case 'component':
      return [0, 1, 2, 3, 4, 5, 6, 7, 11];
    case 'gantt':
      return [0, 1, 2, 8, 11];
    default:
      return [0, 1, 2, 3, 4, 5, 6, 7, 11];
  }
}

function chunkMatchesSection(chunk, nums) {
  const k = titleOrderKey(chunk.title);
  return nums.includes(k);
}

/**
 * @param {{ title: string, body: string }[]} chunks
 * @param {string} userText
 */
function scoreChunk(chunk, userText) {
  const blob = `${chunk.title}\n${chunk.body.slice(0, 1200)}`.toLowerCase();
  const q = String(userText || '').toLowerCase();
  if (!q.trim()) return 0;
  let s = 0;
  const toks = q.split(/[\s,，.。;；、]+/).filter((w) => w.length >= 2);
  for (const w of toks) {
    if (w.length > 40) continue;
    if (blob.includes(w)) s += 1;
  }
  return s;
}

/**
 * @param {object} opts
 * @param {string} opts.kbPath
 * @param {DiagramIntent} opts.intent
 * @param {string} opts.userText
 * @param {number} [opts.maxChars]
 * @param {string} [opts.jarLabel]
 */
export function buildKnowledgeInjection(opts) {
  const maxChars = Number(opts.maxChars) > 2000 ? Number(opts.maxChars) : 38000;
  const intent = opts.intent || 'other';
  const userText = String(opts.userText || '');
  const jarLabel = String(opts.jarLabel || '').trim();

  const p = String(opts.kbPath || '');
  let full = '';
  if (p && existsSync(p)) {
    try {
      full = readFileSync(p, 'utf8');
    } catch {
      full = '';
    }
  }
  if (!full) {
    return {
      l0: defaultL0(jarLabel, intent, false),
      kbExcerpt: '',
      selectedTitles: [],
      truncated: false,
      fallback: true,
    };
  }

  const chunks = splitKbByH2(full);
  const nums = preferredSectionNums(intent);
  let ordered = chunks.filter((c) => chunkMatchesSection(c, nums));
  if (!ordered.length) ordered = [...chunks];

  // 补充高分块（意图路由未覆盖到的长尾）
  const extras = chunks
    .filter((c) => !ordered.includes(c))
    .map((c) => ({ c, sc: scoreChunk(c, userText) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 2)
    .map((x) => x.c);
  ordered = [...ordered, ...extras];

  const seen = new Set();
  const dedup = [];
  for (const c of ordered) {
    const key = c.title;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(c);
  }

  const l0 = defaultL0(jarLabel, intent, true);
  const budget = Math.max(4000, maxChars - l0.length - 400);
  let used = 0;
  const picked = [];
  const titles = [];

  for (const c of dedup) {
    const piece = `${c.body}\n\n`;
    if (used + piece.length > budget) {
      const room = budget - used - 20;
      if (room > 400) {
        picked.push(`${c.body.slice(0, room)}\n\n…（本节节选）\n`);
        titles.push(`${c.title}（节选）`);
        used = budget;
      }
      break;
    }
    picked.push(piece);
    titles.push(c.title);
    used += piece.length;
  }

  let kbExcerpt = picked.join('\n---\n').trim();
  let truncated = false;
  let fallback = false;

  if (!kbExcerpt || kbExcerpt.length < 800) {
    kbExcerpt = full.length <= budget ? full : `${full.slice(0, budget)}\n\n…（知识库前缀回退截断）`;
    truncated = full.length > budget;
    fallback = true;
    titles.length = 0;
    titles.push('前缀回退');
  } else if (full.length > kbExcerpt.length + 500) {
    truncated = true;
  }

  return {
    l0: defaultL0(jarLabel, intent, true),
    kbExcerpt,
    selectedTitles: titles,
    truncated,
    fallback,
  };
}

function defaultL0(jarLabel, intent, kbLoaded) {
  const jar = jarLabel ? `绑定 JAR：${jarLabel}` : 'JAR 版本未解析';
  const lines = [
    '【L0 护栏 — 每请求必遵守】',
    '- 只输出一段完整、可被本地 PlantUML 渲染的源码；必须成对 @start… @end…。',
    '- 禁止仅输出 Markdown；若用代码块包裹，块内须为完整 PlantUML。',
    `- ${jar}。`,
    `- 当前意图标签（机器注入）：${intent}；知识库：${kbLoaded ? '已加载' : '未加载'}。`,
    '- 当「模式专规」与下文「通用 note 假设」冲突时：以模式专规与本 L0 为准（@startchen 时严禁 note；国内高校活动图禁止 start/stop 等见专规）。',
  ];
  return lines.join('\n');
}

/** 供主进程解析 vendor JAR 显示名 */
export function resolveJarLabelFromDirs(candidates) {
  for (const dir of candidates) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const jars = readdirSync(dir).filter((f) => f.startsWith('plantuml-') && f.endsWith('.jar'));
      if (!jars.length) continue;
      jars.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
      return jars[0];
    } catch {
      /* ignore */
    }
  }
  return '';
}
