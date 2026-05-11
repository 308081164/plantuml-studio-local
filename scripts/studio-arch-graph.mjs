/**
 * 静态依赖 / 模块结构 SVG（黑白灰），基于仓库静态扫描，不执行代码。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, dirname, normalize } from 'node:path';
import { collectProjectManifest, parseIgnoreGlobLines } from './project-index.mjs';

const CODE_EXT = new Set(['.py', '.js', '.ts', '.tsx', '.mjs', '.cjs']);

/**
 * @param {string} block 含 @studio-arch … @endstudio-arch
 */
export function parseArchSpec(block) {
  const inner = String(block || '')
    .replace(/^@studio-arch\s*/i, '')
    .replace(/@endstudio-arch\s*$/i, '')
    .trim();
  const spec = { title: '静态依赖概览', focus_paths: [], notes: '' };
  const lines = inner.split(/\r?\n/);
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (m) {
      inList = false;
      const k = m[1].toLowerCase();
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (k === 'title') spec.title = v || spec.title;
      else if (k === 'notes') spec.notes = v;
      else if (k === 'focus_paths' || k === 'focuspaths') {
        inList = true;
        if (v && v !== '|') {
          spec.focus_paths.push(v);
          inList = false;
        }
      }
      continue;
    }
    if (inList && /^\s*-\s+(.+)$/.test(line)) {
      const mm = line.match(/^\s*-\s+(.+)$/);
      if (mm) spec.focus_paths.push(mm[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return spec;
}

function posix(p) {
  return p.split(sep).join('/');
}

function readHead(path, max = 96 * 1024) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size <= 0) return '';
    const buf = readFileSync(path);
    const slice = buf.slice(0, Math.min(max, buf.length));
    return slice.toString('utf8').replace(/\u0000/g, '');
  } catch {
    return '';
  }
}

/**
 * @param {string} content
 * @param {string} relPath posix
 * @param {Set<string>} fileSet posix rel paths
 * @param {string} root
 */
function extractPythonLineEdges(content, relPath, fileSet, root) {
  const edges = [];
  const addEdge = (toRel) => {
    const t = posix(toRel);
    if (t && fileSet.has(t)) edges.push({ from: relPath, to: t });
  };
  for (const line of content.split(/\n/)) {
    const fm = line.match(/^\s*from\s+([\w.]+)\s+import\b/);
    if (fm) {
      const resolved = resolvePythonModule(root, fm[1], fileSet);
      if (resolved) addEdge(resolved);
      continue;
    }
    const im = line.match(/^\s*import\s+(.+?)\s*(?:#|$)/);
    if (im) {
      const body = im[1].split('#')[0];
      for (const part of body.split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (!name) continue;
        const top = name.split('.')[0];
        const resolved = resolvePythonModule(root, top, fileSet);
        if (resolved) addEdge(resolved);
      }
    }
  }
  return edges;
}

function extractEdgesJs(content, relPath, fileSet, root) {
  const edges = [];
  const addEdge = (toRel) => {
    const t = posix(toRel);
    if (t && fileSet.has(t)) edges.push({ from: relPath, to: t });
  };
  const nativeRel = relPath.replace(/\//g, sep);
  const fromDir = join(root, dirname(nativeRel));
  const jsRel = /(?:import|export)\s+[^'"]*?\s+from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = jsRel.exec(content))) {
    const specPath = m[1];
    const target = normalize(join(fromDir, specPath));
    let relT = posix(relative(root, target));
    if (relT.startsWith('..')) continue;
    const hasExt = /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(relT);
    const toTry = hasExt
      ? [relT]
      : [relT, `${relT}.ts`, `${relT}.tsx`, `${relT}.js`, `${relT}.jsx`, `${relT}.mjs`, `${relT}.cjs`];
    for (const cand of toTry) {
      if (fileSet.has(cand)) {
        addEdge(cand);
        break;
      }
    }
  }
  return edges;
}

function extractEdges(content, relPath, fileSet, root) {
  const edges = [];
  edges.push(...extractPythonLineEdges(content, relPath, fileSet, root));
  edges.push(...extractEdgesJs(content, relPath, fileSet, root));
  return edges;
}

function resolvePythonModule(_root, mod, fileSet) {
  const parts = mod.split('.').filter(Boolean);
  if (!parts.length) return null;
  const asPath = parts.join('/');
  const candPy = `${asPath}.py`;
  if (fileSet.has(candPy)) return candPy;
  const candInit = `${asPath}/__init__.py`;
  if (fileSet.has(candInit)) return candInit;
  // package directory module foo/bar.py from import foo.bar
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const parent = parts.slice(0, -1).join('/');
    const cand2 = `${parent}/${last}.py`;
    if (fileSet.has(cand2)) return cand2;
  }
  return null;
}

function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const k = `${e.from}>>${e.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/**
 * @param {{ projectRoot: string, ignoreGlobsText?: string, archBlock: string }}
 */
export function renderStudioArchSvg({ projectRoot, ignoreGlobsText = '', archBlock }) {
  if (!projectRoot || !existsSync(projectRoot)) {
    throw new Error('项目根目录无效或不存在');
  }
  const spec = parseArchSpec(archBlock);
  const userPatterns = parseIgnoreGlobLines(String(ignoreGlobsText || ''));
  const { files } = collectProjectManifest(projectRoot, { userIgnoreGlobs: userPatterns });
  const codeFiles = files.filter((f) => CODE_EXT.has(f.ext || ''));
  const fileSet = new Set(codeFiles.map((f) => posix(f.path)));

  const edges = [];
  const root = projectRoot;
  for (const f of codeFiles.slice(0, 800)) {
    const full = join(root, f.path);
    const txt = readHead(full);
    if (!txt) continue;
    edges.push(...extractEdges(txt, posix(f.path), fileSet, root));
  }
  const edgeList = dedupeEdges(edges).slice(0, 600);

  const nodeSet = new Set();
  for (const e of edgeList) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }
  for (const f of codeFiles.slice(0, 400)) nodeSet.add(posix(f.path));
  const nodes = [...nodeSet].sort((a, b) => a.localeCompare(b));

  const focus = new Set((spec.focus_paths || []).map((p) => posix(p.replace(/\\/g, '/'))));
  const colW = 260;
  const rowH = 36;
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const rows = Math.ceil(nodes.length / cols);
  const pad = 40;
  const w = pad * 2 + cols * colW;
  const h = pad * 2 + rows * rowH + (spec.notes ? 56 : 20);

  const pos = new Map();
  nodes.forEach((id, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    pos.set(id, { x: pad + c * colW + 8, y: pad + r * rowH + 8, w: colW - 24, h: rowH - 10 });
  });

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  svg += `<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>`;
  svg += `<text x="${pad}" y="${pad - 10}" font-size="16" fill="#111111" font-family="Segoe UI, Microsoft YaHei UI, sans-serif">${esc(
    spec.title
  )}</text>`;

  for (const id of nodes) {
    const p = pos.get(id);
    if (!p) continue;
    const isFocus = [...focus].some((fp) => id === fp || id.startsWith(`${fp}/`) || fp.startsWith(`${id}/`));
    const stroke = isFocus ? '#111111' : '#666666';
    const sw = isFocus ? 2 : 1;
    const fill = '#f4f4f4';
    svg += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
    const label = id.length > 42 ? `${id.slice(0, 20)}…${id.slice(-16)}` : id;
    svg += `<text x="${p.x + 6}" y="${p.y + p.h / 2 + 4}" font-size="11" fill="#111111" font-family="Consolas, monospace">${esc(
      label
    )}</text>`;
  }

  for (const e of edgeList) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    svg += `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="#999999" stroke-width="1"/>`;
  }

  if (spec.notes) {
    svg += `<text x="${pad}" y="${h - 24}" font-size="11" fill="#666666" font-family="Segoe UI, Microsoft YaHei UI, sans-serif">${esc(
      spec.notes
    )}</text>`;
  }
  svg += `<!-- nodes=${nodes.length} edges=${edgeList.length} files=${codeFiles.length} -->`;
  svg += '</svg>';
  return { svg, meta: { nodes: nodes.length, edges: edgeList.length, files: codeFiles.length } };
}
