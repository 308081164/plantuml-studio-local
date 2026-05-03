/**
 * 本地项目目录轻量索引（供 DeepSeek 提示使用，不递归整库无上限）
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'release',
  'win-unpacked',
  'coverage',
  '.next',
  '.nuxt',
  'vendor',
]);

const TEXT_EXT = new Set([
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.java',
  '.kt',
  '.kts',
  '.py',
  '.go',
  '.rs',
  '.cs',
  '.vue',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.puml',
  '.gradle',
  '.properties',
  '.xml',
  '.html',
  '.css',
  '.sql',
]);

const MAX_DEPTH = 5;
const MAX_ENTRIES = 380;
const MAX_LIST_LINES = 320;
const MAX_SNIPPETS = 16;
const SNIP_LEN = 850;
const MAX_FILE_READ = 56 * 1024;

function normalizeGitignorePatterns(content) {
  const patterns = [];
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    patterns.push(t.replace(/\\/g, '/'));
  }
  return patterns;
}

/** 极简 .gitignore：目录后缀规则与简单子串（足够 MVP，非完整 git 规范） */
function simpleGitignoreMatch(relPosix, patterns) {
  for (const p of patterns) {
    const pat = p.startsWith('/') ? p.slice(1) : p;
    if (pat.endsWith('/')) {
      const d = pat.slice(0, -1);
      if (relPosix === d || relPosix.startsWith(`${d}/`)) return true;
    } else if (relPosix === pat || relPosix.endsWith(`/${pat}`) || relPosix.includes(`/${pat}/`)) return true;
  }
  return false;
}

/**
 * @param {string} rootPath
 * @returns {{ summary: string, stats: { entries: number, snippetCount: number, linesListed: number } }}
 */
export function buildProjectSummary(rootPath) {
  if (!rootPath || typeof rootPath !== 'string') throw new Error('项目路径无效');
  if (!existsSync(rootPath)) throw new Error('项目路径不存在');
  const st = statSync(rootPath);
  if (!st.isDirectory()) throw new Error('请选择目录而非文件');

  let gitignorePatterns = [];
  const gi = join(rootPath, '.gitignore');
  if (existsSync(gi)) {
    try {
      gitignorePatterns = normalizeGitignorePatterns(readFileSync(gi, 'utf8'));
    } catch {
      /* ignore */
    }
  }

  const lines = [];
  const snippets = [];
  let count = 0;

  function walk(dir, depth) {
    if (depth > MAX_DEPTH || count >= MAX_ENTRIES) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (count >= MAX_ENTRIES) return;
      if (name === '.' || name === '..') continue;
      const full = join(dir, name);
      let rel;
      try {
        rel = relative(rootPath, full);
      } catch {
        continue;
      }
      const relPosix = rel.split(sep).join('/');
      if (!relPosix || relPosix.startsWith('..')) continue;
      if (SKIP_DIR_NAMES.has(name)) continue;
      if (gitignorePatterns.length && simpleGitignoreMatch(relPosix, gitignorePatterns)) continue;

      let st2;
      try {
        st2 = statSync(full);
      } catch {
        continue;
      }

      if (st2.isDirectory()) {
        lines.push(`[dir] ${relPosix}/`);
        count++;
        walk(full, depth + 1);
      } else if (st2.isFile()) {
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
        lines.push(`[file] ${relPosix} (${st2.size} B)`);
        count++;
        if (
          snippets.length < MAX_SNIPPETS &&
          TEXT_EXT.has(ext) &&
          st2.size > 0 &&
          st2.size <= MAX_FILE_READ
        ) {
          try {
            const raw = readFileSync(full, 'utf8');
            const slice = raw.slice(0, SNIP_LEN).replace(/\u0000/g, '');
            snippets.push(
              `--- ${relPosix} (前 ${Math.min(SNIP_LEN, raw.length)} 字符) ---\n${slice}${
                raw.length > SNIP_LEN ? '\n…(截断)' : ''
              }`
            );
          } catch {
            /* 二进制或编码问题 */
          }
        }
      }
    }
  }

  walk(rootPath, 0);

  const listed = lines.slice(0, MAX_LIST_LINES);
  const summary = [
    `扫描项数约：${count}（硬上限 ${MAX_ENTRIES}；已跳过常见依赖/构建目录名；若存在 .gitignore 则做简单路径匹配，非完整 git 语义）`,
    '',
    '【文件与目录列表（相对根路径）】',
    listed.join('\n'),
    lines.length > MAX_LIST_LINES ? `\n… 另有 ${lines.length - MAX_LIST_LINES} 条未列出` : '',
    '',
    '【源码节选（仅供推断模块关系，不等价于完整审阅）】',
    snippets.join('\n\n') || '(无合适文本小节)',
  ].join('\n');

  return {
    summary,
    stats: {
      entries: count,
      snippetCount: snippets.length,
      linesListed: listed.length,
    },
  };
}

/* ---------- 第 11 节：清单扫描、隐私排除、启发式选文件 ---------- */

export const CHARS_PER_TOKEN_EST = 3.5;
/** 产品级：组装后的首轮 user 消息粗算超过此值则中止（不实现自动压缩） */
export const MAX_ASSEMBLED_USER_TOKENS = 1_000_000;
/** 单次 DeepSeek 请求建议上限（留出 system / 重试文案空间） */
export const MAX_SINGLE_REQUEST_TOKEN_BUDGET = 108_000;

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN_EST);
}

const SECRET_NAME_EXACT = new Set(
  [
    '.env',
    '.npmrc',
    '.pypirc',
    'credentials',
    'credentials.json',
    'google-services.json',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'keystore.jks',
    'local.properties',
  ].map((s) => s.toLowerCase())
);

function isLikelySecretPath(relPosix, baseName) {
  const b = baseName.toLowerCase();
  const r = relPosix.replace(/\\/g, '/').toLowerCase();
  if (SECRET_NAME_EXACT.has(b)) return true;
  if (b.startsWith('.env')) return true;
  if (b === 'config' && r.includes('aws')) return false;
  if (/^\.?secrets?\./i.test(b) || /^secret[^/]*$/i.test(b)) return true;
  if (/(^|[/])\.ssh[/]/.test(r) && !b.endsWith('.pub')) return true;
  if (/\.(pem|p12|pfx|jks|keychain|mobileprovision)$/i.test(r)) return true;
  if (/[._-]?(password|passwd|secret)[._-]?/i.test(b) && /\.(json|ya?ml|txt|env)$/i.test(b)) return true;
  if (/id_rsa|id_ecdsa|id_ed25519|id_dsa/i.test(b) && !b.endsWith('.pub')) return true;
  return false;
}

/** 将用户输入的忽略规则按行解析（glob 风格，见 userIgnoreMatch） */
export function parseIgnoreGlobLines(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function globToRegExp(pattern) {
  let p = String(pattern || '')
    .trim()
    .replace(/\\/g, '/');
  if (!p) return /^$/i;
  /** 无 `/` 的规则：匹配任意目录深度下的 basename（与常见 .gitignore 行为接近） */
  const anyDepthPrefix = !p.includes('/') ? '(?:.*/)?' : '';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      re += '.*';
      i++;
      if (p[i + 1] === '/') i++;
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
      continue;
    }
    if ('\\.^$+()[]{}|'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${anyDepthPrefix}${re}$`, 'i');
}

export function userIgnoreMatch(relPosix, patterns) {
  const r = relPosix.replace(/\\/g, '/');
  for (const pat of patterns) {
    try {
      if (globToRegExp(pat).test(r)) return true;
    } catch {
      /* ignore bad pattern */
    }
  }
  return false;
}

function scorePathForHeuristic(relPosix) {
  const r = relPosix.replace(/\\/g, '/').toLowerCase();
  let s = 0;
  if (r === 'package.json' || r.endsWith('/package.json')) s += 120;
  if (r.endsWith('readme.md') || r.endsWith('readme.txt') || r.endsWith('/readme')) s += 85;
  if (/tsconfig.*\.json$/.test(r)) s += 75;
  if (/(^|\/)go\.mod$/.test(r)) s += 75;
  if (/(^|\/)pom\.xml$/.test(r) || /(^|\/)build\.gradle/.test(r)) s += 75;
  if (/(^|\/)pyproject\.toml$/.test(r) || /(^|\/)requirements.*\.txt$/.test(r)) s += 70;
  if (/(^|\/)cargo\.toml$/.test(r)) s += 70;
  if (/(^|\/)dockerfile$/.test(r) || r.endsWith('/dockerfile')) s += 55;
  if (/\/src\//.test(r) || r.startsWith('src/')) s += 45;
  if (/\/lib\//.test(r) || r.startsWith('lib/')) s += 35;
  if (/\/apps?\//.test(r)) s += 30;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|py|java|kt|go|rs|cs)$/.test(r)) s += 15;
  return s;
}

/**
 * 规划失败时的本地选路：按启发式分数取前 maxN 个不重复 path
 * @param {{ path: string, bytes?: number }[]} files
 */
export function heuristicPrioritizedPaths(files, maxN = 35) {
  const scored = (files || []).map((f) => ({ p: f.path, s: scorePathForHeuristic(f.path), b: f.bytes || 0 }));
  scored.sort((a, b) => b.s - a.s || a.b - b.b);
  const out = [];
  const seen = new Set();
  for (const { p } of scored) {
    if (out.length >= maxN) break;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

const MANIFEST_MAX_DEPTH = 8;
const MANIFEST_MAX_FILES = 5200;
const MANIFEST_HEAD_READ = 4096;
const MANIFEST_HEAD_OUT = 220;

/**
 * 构建项目文件清单（供规划模型 + 后续按路径读取）
 * @param {string} rootPath
 * @param {{ userIgnoreGlobs?: string[] }} options
 */
export function collectProjectManifest(rootPath, options = {}) {
  if (!rootPath || typeof rootPath !== 'string') throw new Error('项目路径无效');
  if (!existsSync(rootPath)) throw new Error('项目路径不存在');
  const st = statSync(rootPath);
  if (!st.isDirectory()) throw new Error('请选择目录而非文件');

  const userPatterns = Array.isArray(options.userIgnoreGlobs) ? options.userIgnoreGlobs : [];

  let gitignorePatterns = [];
  const gi = join(rootPath, '.gitignore');
  if (existsSync(gi)) {
    try {
      gitignorePatterns = normalizeGitignorePatterns(readFileSync(gi, 'utf8'));
    } catch {
      /* ignore */
    }
  }

  const files = [];
  const shortTreeLines = [];
  const MAX_TREE = 140;
  let treeCount = 0;
  let skippedSecrets = 0;
  let skippedUserIgnore = 0;
  let skippedGitignore = 0;
  let hitCap = false;

  function walk(dir, depth) {
    if (depth > MANIFEST_MAX_DEPTH || files.length >= MANIFEST_MAX_FILES) {
      if (files.length >= MANIFEST_MAX_FILES) hitCap = true;
      return;
    }
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= MANIFEST_MAX_FILES) {
        hitCap = true;
        return;
      }
      if (name === '.' || name === '..') continue;
      const full = join(dir, name);
      let rel;
      try {
        rel = relative(rootPath, full);
      } catch {
        continue;
      }
      const relPosix = rel.split(sep).join('/');
      if (!relPosix || relPosix.startsWith('..')) continue;
      if (SKIP_DIR_NAMES.has(name)) continue;
      if (gitignorePatterns.length && simpleGitignoreMatch(relPosix, gitignorePatterns)) {
        skippedGitignore++;
        continue;
      }
      if (userPatterns.length && userIgnoreMatch(relPosix, userPatterns)) {
        skippedUserIgnore++;
        continue;
      }

      let st2;
      try {
        st2 = statSync(full);
      } catch {
        continue;
      }

      if (st2.isDirectory()) {
        if (treeCount < MAX_TREE) {
          shortTreeLines.push(`[dir] ${relPosix}/`);
          treeCount++;
        }
        walk(full, depth + 1);
      } else if (st2.isFile()) {
        if (isLikelySecretPath(relPosix, name)) {
          skippedSecrets++;
          continue;
        }
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
        if (treeCount < MAX_TREE) {
          shortTreeLines.push(`[file] ${relPosix} (${st2.size} B)`);
          treeCount++;
        }
        if (!TEXT_EXT.has(ext) || st2.size <= 0) continue;
        if (st2.size > MAX_FILE_READ * 4) {
          files.push({ path: relPosix, bytes: st2.size, ext, head: '(文件过大，未读头)' });
          continue;
        }
        let head = '';
        try {
          const raw = readFileSync(full, 'utf8');
          const slice = raw.slice(0, MANIFEST_HEAD_READ).replace(/\u0000/g, '');
          head = slice.replace(/\s+/g, ' ').slice(0, MANIFEST_HEAD_OUT);
        } catch {
          head = '(非 UTF-8 或二进制，未收录头) ';
        }
        files.push({ path: relPosix, bytes: st2.size, ext, head });
      }
    }
  }

  walk(rootPath, 0);

  return {
    files,
    shortTreeLines,
    stats: {
      fileCount: files.length,
      skippedSecrets,
      skippedUserIgnore,
      skippedGitignore,
      hitCap,
    },
  };
}
