#!/usr/bin/env node
/**
 * One-shot patch: stash archive layout, autoStashOnGenerate, PlantUML help IPC.
 * Run from repo root after restoring electron-main.mjs from main.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'electron-main.mjs');
let s = readFileSync(path, 'utf8');

const autoStashDefault = `  /** 智能生成成功后自动写入产出物暂存区 */
  autoStashOnGenerate: true,`;

if (!s.includes('autoStashOnGenerate')) {
  s = s.replace(
    '  referenceVisionMaxRounds: AGENT_REFERENCE_VISION_MAX_ROUNDS_DEFAULT,\n};',
    `  referenceVisionMaxRounds: AGENT_REFERENCE_VISION_MAX_ROUNDS_DEFAULT,\n${autoStashDefault}\n};`
  );
  s = s.replace(
    `      referenceVisionMaxRounds: Number.isFinite(Number(j.referenceVisionMaxRounds))
        ? Math.max(0, Math.min(5, Number(j.referenceVisionMaxRounds)))
        : DEFAULT_AGENT.referenceVisionMaxRounds,
    };`,
    `      referenceVisionMaxRounds: Number.isFinite(Number(j.referenceVisionMaxRounds))
        ? Math.max(0, Math.min(5, Number(j.referenceVisionMaxRounds)))
        : DEFAULT_AGENT.referenceVisionMaxRounds,
      autoStashOnGenerate: j.autoStashOnGenerate === false || j.autoStashOnGenerate === 'false' ? false : true,
    };`
  );
  s = s.replace(
    `    referenceVisionMaxRounds:
      partial.referenceVisionMaxRounds != null
        ? Math.max(0, Math.min(5, Number(partial.referenceVisionMaxRounds) || 0))
        : cur.referenceVisionMaxRounds,
  };`,
    `    referenceVisionMaxRounds:
      partial.referenceVisionMaxRounds != null
        ? Math.max(0, Math.min(5, Number(partial.referenceVisionMaxRounds) || 0))
        : cur.referenceVisionMaxRounds,
    autoStashOnGenerate:
      partial.autoStashOnGenerate != null
        ? !(partial.autoStashOnGenerate === false || partial.autoStashOnGenerate === 'false')
        : cur.autoStashOnGenerate,
  };`
  );
}

const oldStashBlock = `/* ---------- 产出物暂存区（用户目录持久化） ---------- */

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
  return join(stashItemsDir(), \`\${id}.png\`);
}

function stashSvgPath(id) {
  return join(stashItemsDir(), \`\${id}.svg\`);
}

function stashThumbPath(id) {
  return join(stashItemsDir(), \`\${id}.thumb.png\`);
}

function stashPumlPath(id) {
  return join(stashItemsDir(), \`\${id}.puml\`);
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
}`;

const newStashBlock = `/* ---------- 产出物暂存区（用户目录持久化） ---------- */

const STASH_DEFAULT_PROJECT = '默认项目';

function stashRoot() {
  return join(app.getPath('userData'), 'output-stash');
}

function stashItemsDir() {
  return join(stashRoot(), 'items');
}

function stashManifestPath() {
  return join(stashRoot(), 'manifest.json');
}

function sanitizeStashSegment(name) {
  const seg = String(name ?? '')
    .trim()
    .replace(/[<>:"/\\\\|?*\\x00-\\x1f]/g, '_')
    .replace(/\\.+\$/g, '')
    .replace(/\\s+/g, ' ');
  return (seg || STASH_DEFAULT_PROJECT).slice(0, 72);
}

function stashDateKeyFromTs(ts) {
  const d = new Date(Number(ts) || Date.now());
  return \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`;
}

/** @param {{ id: string, storageDir?: string }} meta */
function resolveStashItemDir(meta) {
  if (meta?.storageDir) return join(stashRoot(), meta.storageDir);
  return stashItemsDir();
}

/** @param {{ id: string, storageDir?: string }} meta */
function stashPngPathFor(meta) {
  return join(resolveStashItemDir(meta), \`\${meta.id}.png\`);
}

/** @param {{ id: string, storageDir?: string }} meta */
function stashSvgPathFor(meta) {
  return join(resolveStashItemDir(meta), \`\${meta.id}.svg\`);
}

/** @param {{ id: string, storageDir?: string }} meta */
function stashThumbPathFor(meta) {
  return join(resolveStashItemDir(meta), \`\${meta.id}.thumb.png\`);
}

/** @param {{ id: string, storageDir?: string }} meta */
function stashPumlPathFor(meta) {
  return join(resolveStashItemDir(meta), \`\${meta.id}.puml\`);
}

function stashPngPath(id) {
  return join(stashItemsDir(), \`\${id}.png\`);
}

function stashSvgPath(id) {
  return join(stashItemsDir(), \`\${id}.svg\`);
}

function stashThumbPath(id) {
  return join(stashItemsDir(), \`\${id}.thumb.png\`);
}

function stashPumlPath(id) {
  return join(stashItemsDir(), \`\${id}.puml\`);
}

function ensureStashDirs() {
  mkdirSync(stashItemsDir(), { recursive: true });
  mkdirSync(join(stashRoot(), 'archive'), { recursive: true });
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

function removeStashFiles(meta) {
  const m = meta && typeof meta === 'object' ? meta : { id: String(meta || '') };
  for (const p of [
    stashPngPathFor(m),
    stashSvgPathFor(m),
    stashThumbPathFor(m),
    stashPumlPathFor(m),
    stashPngPath(m.id),
    stashSvgPath(m.id),
    stashThumbPath(m.id),
    stashPumlPath(m.id),
  ]) {
    try {
      if (p && existsSync(p)) unlinkSync(p);
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
      (m.kind === 'png' && (existsSync(stashPngPathFor(m)) || existsSync(stashPngPath(m.id)))) ||
      (m.kind === 'svg' && (existsSync(stashSvgPathFor(m)) || existsSync(stashSvgPath(m.id))));
    return ok;
  });
  if (items.length !== before) writeStashManifest(items);
  return items;
}

function findPlantumlQuickGuidePath() {
  const candidates = [
    join(process.resourcesPath || '', 'kb', 'PlantUML-Quick-Start-ZH.md'),
    join(__dirname, 'vendor', 'kb', 'PlantUML-Quick-Start-ZH.md'),
  ];
  for (const cand of candidates) {
    if (cand && existsSync(cand)) return cand;
  }
  return null;
}`;

if (s.includes('function stashRoot()') && !s.includes('STASH_DEFAULT_PROJECT')) {
  if (!s.includes(oldStashBlock.slice(0, 80))) {
    throw new Error('electron-main stash block anchor not found');
  }
  s = s.replace(oldStashBlock, newStashBlock);
}

const oldBuildPayload = `function buildStashListPayload() {
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
          previewDataUrl = \`data:image/png;base64,\${b.toString('base64')}\`;
        }
      } else {
        const sp = stashSvgPath(meta.id);
        if (existsSync(sp)) {
          let s = readFileSync(sp, 'utf8');
          if (s.length > 40000) s = \`\${s.slice(0, 40000)}\\n<!-- preview truncated -->\`;
          previewDataUrl = \`data:image/svg+xml;charset=utf-8,\${encodeURIComponent(s)}\`;
        }
      }
    } catch {
      /* ignore */
    }
    return { ...meta, previewDataUrl };
  });
  return { ok: true, items: enriched };
}`;

const newBuildPayload = `function buildStashListPayload() {
  const items = pruneStashManifest();
  const enriched = items.map((meta) => {
    let previewDataUrl = '';
    try {
      if (meta.kind === 'png') {
        const tp = stashThumbPathFor(meta);
        const full = stashPngPathFor(meta);
        const legacyTp = stashThumbPath(meta.id);
        const legacyFull = stashPngPath(meta.id);
        const p = existsSync(tp) ? tp : existsSync(full) ? full : existsSync(legacyTp) ? legacyTp : legacyFull;
        if (existsSync(p)) {
          const b = readFileSync(p);
          previewDataUrl = \`data:image/png;base64,\${b.toString('base64')}\`;
        }
      } else {
        const sp = stashSvgPathFor(meta);
        const legacySp = stashSvgPath(meta.id);
        const svgPath = existsSync(sp) ? sp : legacySp;
        if (existsSync(svgPath)) {
          let svgText = readFileSync(svgPath, 'utf8');
          if (svgText.length > 40000) svgText = \`\${svgText.slice(0, 40000)}\\n<!-- preview truncated -->\`;
          previewDataUrl = \`data:image/svg+xml;charset=utf-8,\${encodeURIComponent(svgText)}\`;
        }
      }
    } catch {
      /* ignore */
    }
    return {
      ...meta,
      projectName: meta.projectName || STASH_DEFAULT_PROJECT,
      dateKey: meta.dateKey || stashDateKeyFromTs(meta.createdAt),
      previewDataUrl,
    };
  });
  return { ok: true, items: enriched };
}`;

if (!s.includes('stashThumbPathFor(meta)')) {
  s = s.replace(oldBuildPayload, newBuildPayload);
}

const oldStashAdd = `  ipcMain.handle('studio:stash-add', (_e, payload) => {
    try {
      const snap = getEntitlementSnapshot();
      const gate = gateFromSnapshot(snap);
      if (gate) return gate;
      const lockGate = assertAgentLockBlocksFeature();
      if (lockGate) return lockGate;
      const kind = payload?.kind === 'svg' ? 'svg' : 'png';
      const id = randomUUID();
      ensureStashDirs();
      const labelRaw = payload?.label != null ? String(payload.label).trim() : '';
      const label =
        labelRaw ||
        \`产出 \${new Date().toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })}\`;
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
      maybeConsumeFreeAfterSuccess(snap);
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });`;

const newStashAdd = `  ipcMain.handle('studio:stash-add', (_e, payload) => {
    try {
      const snap = getEntitlementSnapshot();
      const gate = gateFromSnapshot(snap);
      if (gate) return gate;
      const lockGate = assertAgentLockBlocksFeature();
      if (lockGate) return lockGate;
      const kind = payload?.kind === 'svg' ? 'svg' : 'png';
      const id = randomUUID();
      ensureStashDirs();
      const labelRaw = payload?.label != null ? String(payload.label).trim() : '';
      const label =
        labelRaw ||
        \`产出 \${new Date().toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })}\`;
      const sourceText = payload?.sourceText != null ? String(payload.sourceText) : '';
      const createdAt = Date.now();
      const projectName = sanitizeStashSegment(payload?.projectName || STASH_DEFAULT_PROJECT);
      const dateKey = stashDateKeyFromTs(createdAt);
      const storageDir = join('archive', projectName, dateKey);
      mkdirSync(join(stashRoot(), storageDir), { recursive: true });
      const fileMeta = { id, storageDir };

      if (kind === 'png') {
        const buf = Buffer.from(new Uint8Array(payload?.arrayBuffer || []));
        if (!buf.length) return { ok: false, error: 'PNG 数据为空' };
        writeFileSync(stashPngPathFor(fileMeta), buf);
        try {
          const ni = nativeImage.createFromBuffer(buf);
          const thumb = ni.resize({ width: 168 });
          const tb = thumb.toPNG();
          if (tb && tb.length) writeFileSync(stashThumbPathFor(fileMeta), tb);
        } catch {
          /* 略过缩略图 */
        }
      } else {
        const svg = String(payload?.svgText || '');
        if (!svg.trim()) return { ok: false, error: 'SVG 内容为空' };
        writeFileSync(stashSvgPathFor(fileMeta), svg, 'utf8');
      }

      if (sourceText.length) {
        writeFileSync(stashPumlPathFor(fileMeta), sourceText.slice(0, 250000), 'utf8');
      }

      const items = readStashManifest();
      items.unshift({
        id,
        createdAt,
        kind,
        label,
        hasPuml: Boolean(sourceText.length),
        projectName,
        dateKey,
        storageDir,
      });
      writeStashManifest(items);
      maybeConsumeFreeAfterSuccess(snap);
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });`;

if (!s.includes("join('archive', projectName, dateKey)")) {
  s = s.replace(oldStashAdd, newStashAdd);
}

s = s.replace(
  `        if (idSet.has(m.id)) {
          removeStashFiles(m.id);
          return false;
        }`,
  `        if (idSet.has(m.id)) {
          removeStashFiles(m);
          return false;
        }`
);

s = s.replace(
  `      if (meta.kind === 'png') {
        const p = stashPngPath(sid);
        if (!existsSync(p)) return { ok: false, error: '文件缺失' };
        const b = readFileSync(p);
        const pp = stashPumlPath(sid);`,
  `      if (meta.kind === 'png') {
        const p = existsSync(stashPngPathFor(meta)) ? stashPngPathFor(meta) : stashPngPath(sid);
        if (!existsSync(p)) return { ok: false, error: '文件缺失' };
        const b = readFileSync(p);
        const pp = existsSync(stashPumlPathFor(meta)) ? stashPumlPathFor(meta) : stashPumlPath(sid);`
);

s = s.replace(
  `      const sp = stashSvgPath(sid);
      if (!existsSync(sp)) return { ok: false, error: '文件缺失' };
      const svgText = readFileSync(sp, 'utf8');
      const pp = stashPumlPath(sid);`,
  `      const sp = existsSync(stashSvgPathFor(meta)) ? stashSvgPathFor(meta) : stashSvgPath(sid);
      if (!existsSync(sp)) return { ok: false, error: '文件缺失' };
      const svgText = readFileSync(sp, 'utf8');
      const pp = existsSync(stashPumlPathFor(meta)) ? stashPumlPathFor(meta) : stashPumlPath(sid);`
);

s = s.replace(
  `      if (meta.kind === 'png') {
        const p = stashPngPath(sid);
        if (!existsSync(p)) return { ok: false, error: '文件缺失' };
        const buf = readFileSync(p);`,
  `      if (meta.kind === 'png') {
        const p = existsSync(stashPngPathFor(meta)) ? stashPngPathFor(meta) : stashPngPath(sid);
        if (!existsSync(p)) return { ok: false, error: '文件缺失' };
        const buf = readFileSync(p);`
);

s = s.replace(
  `      const sp = stashSvgPath(sid);
      if (!existsSync(sp)) return { ok: false, error: '文件缺失' };
      const svg = readFileSync(sp, 'utf8');`,
  `      const sp = existsSync(stashSvgPathFor(meta)) ? stashSvgPathFor(meta) : stashSvgPath(sid);
      if (!existsSync(sp)) return { ok: false, error: '文件缺失' };
      const svg = readFileSync(sp, 'utf8');`
);

if (!s.includes("ipcMain.handle('studio:help-plantuml-guide'")) {
  s = s.replace(
    `  ipcMain.handle('studio:stash-list', () => {`,
    `  ipcMain.handle('studio:help-plantuml-guide', () => {
    try {
      const p = findPlantumlQuickGuidePath();
      if (!p) return { ok: false, error: '未找到 PlantUML 语法速查文档' };
      const markdown = readFileSync(p, 'utf8');
      return { ok: true, markdown };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('studio:stash-list', () => {`
  );
}

writeFileSync(path, s, 'utf8');
console.log('Patched electron-main.mjs');
