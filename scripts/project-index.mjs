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
