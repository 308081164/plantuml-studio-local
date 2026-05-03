/**
 * 第 11 节：规划阶段 JSON 解析 + 受控源码聚合（与 project-index 清单配合）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  CHARS_PER_TOKEN_EST,
  estimateTokens,
  MAX_ASSEMBLED_USER_TOKENS,
  MAX_SINGLE_REQUEST_TOKEN_BUDGET,
} from './project-index.mjs';

/** 将清单压成 JSONL，供规划模型在有限上下文内阅读 */
export function formatManifestJsonl(files, maxLines = 2200) {
  const lines = [];
  const slice = files.slice(0, maxLines);
  for (const f of slice) {
    const head = String(f.head || '')
      .replace(/\s+/g, ' ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .slice(0, 200);
    lines.push(JSON.stringify({ path: f.path, bytes: f.bytes, ext: f.ext || '', head }));
  }
  const truncated = files.length > maxLines;
  return { text: lines.join('\n'), lineCount: lines.length, truncated, totalFiles: files.length };
}

/** 从模型输出中解析 {"paths":[...], "rationale": "..."} */
export function parsePlannerPaths(raw) {
  const s = String(raw || '').trim();
  let rationale = '';
  const tryParse = (jsonStr) => {
    const j = JSON.parse(jsonStr);
    const paths = Array.isArray(j.paths) ? j.paths.map((p) => String(p || '').trim()).filter(Boolean) : [];
    if (typeof j.rationale === 'string') rationale = j.rationale.slice(0, 2000);
    return paths;
  };

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return { paths: tryParse(fence[1].trim()), rationale };
    } catch {
      /* fallthrough */
    }
  }
  const brace = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (brace >= 0 && last > brace) {
    try {
      return { paths: tryParse(s.slice(brace, last + 1)), rationale };
    } catch {
      /* fallthrough */
    }
  }
  const arr = s.match(/\[[\s\S]*?\]/);
  if (arr) {
    try {
      const a = JSON.parse(arr[0]);
      if (Array.isArray(a)) return { paths: a.map(String).filter(Boolean), rationale: '' };
    } catch {
      /* ignore */
    }
  }
  return { paths: [], rationale: '' };
}

function readFileSliceUtf8(fullPath, maxChars) {
  if (!existsSync(fullPath)) return { text: '', note: 'missing' };
  let st;
  try {
    st = statSync(fullPath);
  } catch {
    return { text: '', note: 'stat-fail' };
  }
  if (!st.isFile()) return { text: '', note: 'not-file' };
  if (st.size === 0) return { text: '', note: '' };
  try {
    const raw = readFileSync(fullPath, 'utf8');
    const cleaned = raw.replace(/\u0000/g, '');
    if (cleaned.length <= maxChars) return { text: cleaned, note: '' };
    return {
      text: `${cleaned.slice(0, maxChars)}\n\n/* …本文件已截断，共 ${cleaned.length} 字符，仅前 ${maxChars} 字符送入模型… */\n`,
      note: 'truncated',
    };
  } catch {
    return { text: '', note: 'read-binary-or-encoding' };
  }
}

/**
 * 按给定顺序读取文件，总字符不超过 totalMaxChars（用于适配单次 API 上下文）
 * @param {string} root
 * @param {string[]} relPaths posix 相对路径
 */
export function buildFileBundle(root, relPaths, options = {}) {
  const perFileMax = Number(options.perFileMaxChars) > 0 ? Number(options.perFileMaxChars) : 72_000;
  const totalMax = Number(options.totalMaxChars) > 0 ? Number(options.totalMaxChars) : 360_000;
  const parts = [];
  let used = 0;
  const notes = [];
  const usedPaths = [];

  for (const relPosix of relPaths) {
    if (used >= totalMax) break;
    const rel = String(relPosix || '').trim().replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) continue;
    const full = join(root, ...rel.split('/'));
    const room = totalMax - used - 80;
    if (room < 200) break;
    const cap = Math.min(perFileMax, room);
    const { text, note } = readFileSliceUtf8(full, cap);
    if (!text && note === 'missing') continue;
    const block = `### FILE: ${rel}\n\`\`\`\n${text}\n\`\`\`\n`;
    used += block.length;
    parts.push(block);
    usedPaths.push(rel);
    if (note === 'truncated') notes.push(`${rel}: 单文件截断`);
  }

  return {
    text: parts.join('\n'),
    usedPaths,
    charCount: parts.join('\n').length,
    notes,
  };
}

/** 首轮 user 消息 = header + bundleText + footer（便于按 API 预算为 bundle 留空位） */
export function buildProjectUserBlockParts({
  root,
  userGoal,
  manifestLineCount,
  manifestTruncated,
  skippedSecrets,
  plannerRationale,
  shortTree,
}) {
  const tree = Array.isArray(shortTree) ? shortTree.join('\n') : String(shortTree || '');
  const header = [
    '【项目工作目录（用户已授权）】',
    root,
    '',
    '【本地索引说明】',
    `清单条目约 ${manifestLineCount}；${manifestTruncated ? '已达上限已截断。' : ''}已排除疑似密钥/凭证路径 ${skippedSecrets} 处。`,
    plannerRationale ? `【规划说明】\n${plannerRationale}` : '',
    '',
    '【目录树摘录（仅结构辅助，非完整仓库）】',
    tree || '(无)',
    '',
    '【规划阶段选中的源码与配置文件全文（受控聚合）】',
    '下列片段将发往云端模型用于制图；未列出之文件不代表不存在。',
  ]
    .filter(Boolean)
    .join('\n');

  const footer = [
    '',
    '【制图目标】',
    userGoal,
    '',
    '请输出完整可渲染的 PlantUML 源码（建议单图）。在图中用 note 列出关键假设与可能未覆盖的模块。',
  ].join('\n');

  return { header, footer };
}

export function assembleUserBlock(header, bundleText, footer) {
  const mid = bundleText?.trim() ? bundleText : '(未能读取到文本内容)';
  return `${header}\n${mid}${footer}`;
}

/** 若整段 user 消息超过产品上限 1M tokens，中止并提示 */
export function checkAssembledContextLimit(fullUserText) {
  const est = estimateTokens(fullUserText);
  if (est <= MAX_ASSEMBLED_USER_TOKENS) return { ok: true, estimatedTokens: est };
  return {
    ok: false,
    estimatedTokens: est,
    message: `当前组装的上下文粗算约 ${est} tokens（按每字符≈1/${CHARS_PER_TOKEN_EST} 估算），已超过产品上限 ${MAX_ASSEMBLED_USER_TOKENS}。请缩小项目范围、在「自定义忽略」中排除大目录、缩短自然语言需求，或拆分仓库后分多次制图；亦可新建会话分段处理。本次不提供自动压缩。`,
  };
}

/**
 * 在已知「非 bundle」前缀长度下，为 bundle 计算安全字符上限，使整段 user 消息不超过 API 建议上限
 */
export function computeBundleCharBudget(prefixWithoutBundle, suffixAfterBundle = '') {
  const fixed = String(prefixWithoutBundle) + String(suffixAfterBundle);
  const fixedTokens = estimateTokens(fixed);
  const room = Math.max(8_000, MAX_SINGLE_REQUEST_TOKEN_BUDGET - fixedTokens - 800);
  return Math.floor(room * CHARS_PER_TOKEN_EST);
}
