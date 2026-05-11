/**
 * 下载 PlantUML 官方 JAR（GPL 主包 plantuml-{version}.jar）到 vendor/plantuml/，供 electron-builder extraResources 打包。
 * 仓库 .gitignore 排除 *.jar，故 CI 必须在构建前执行本脚本。
 *
 * 环境变量：
 * - SKIP_PLANTUML_DOWNLOAD=1 — 跳过（已有 JAR 时也会跳过）
 * - PLANTUML_JAR_URL — 直接指定下载地址（可选，覆盖 GitHub latest 解析）
 * - GITHUB_TOKEN — 可选，提高 api.github.com 请求额度
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'vendor', 'plantuml');

function hasAnyJar() {
  if (!existsSync(outDir)) return false;
  return readdirSync(outDir).some((f) => f.startsWith('plantuml-') && f.endsWith('.jar'));
}

async function fetchWithRetry(url, attempts = 4) {
  const headers = {};
  const tok = String(process.env.GITHUB_TOKEN || '').trim();
  if (tok) headers.Authorization = `Bearer ${tok}`;

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers,
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      const wait = 3000 * (i + 1);
      console.warn(`[download-plantuml] 第 ${i + 1} 次失败，${wait}ms 后重试:`, e.message || e);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main() {
  if (process.env.SKIP_PLANTUML_DOWNLOAD === '1') {
    console.log('[download-plantuml] SKIP_PLANTUML_DOWNLOAD=1，跳过。');
    return;
  }
  if (hasAnyJar()) {
    console.log('[download-plantuml] vendor/plantuml/ 下已有 JAR，跳过。');
    return;
  }

  mkdirSync(outDir, { recursive: true });

  const direct = String(process.env.PLANTUML_JAR_URL || '').trim();
  let downloadUrl = direct;
  let outName = '';

  if (!downloadUrl) {
    const api = 'https://api.github.com/repos/plantuml/plantuml/releases/latest';
    console.log('[download-plantuml] 解析', api);
    const res = await fetchWithRetry(api);
    const j = await res.json();
    const tag = String(j.tag_name || '');
    const ver = tag.startsWith('v') ? tag.slice(1) : tag;
    if (!ver) throw new Error('[download-plantuml] 无法解析 release tag');
    outName = `plantuml-${ver}.jar`;
    const asset = (j.assets || []).find((a) => a && a.name === outName);
    if (!asset?.browser_download_url) {
      throw new Error(`[download-plantuml] latest 中未找到资源 ${outName}`);
    }
    downloadUrl = asset.browser_download_url;
  } else {
    outName = direct.split('/').pop() || 'plantuml.jar';
    if (!outName.endsWith('.jar')) outName = 'plantuml-download.jar';
  }

  const dest = join(outDir, outName);
  console.log('[download-plantuml] 正在下载', downloadUrl);
  const bin = await fetchWithRetry(downloadUrl);
  const buf = Buffer.from(await bin.arrayBuffer());
  if (buf.length < 50_000) {
    throw new Error(`[download-plantuml] 文件过小 (${buf.length})，可能非有效 JAR`);
  }
  writeFileSync(dest, buf);
  console.log('[download-plantuml] 已写入', dest, '大小', buf.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
