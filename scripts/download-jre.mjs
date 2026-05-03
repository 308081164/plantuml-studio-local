/**
 * 下载 Eclipse Temurin Windows x64 JRE（用于打包，可在任意 OS 上执行以下载 Windows 包）。
 * 输出：plantuml-desktop/vendor/jre/
 * 跳过：已有 vendor/jre/bin/java.exe，或 SKIP_JRE_DOWNLOAD=1
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const vendorDir = join(root, 'vendor');
const jreDir = join(vendorDir, 'jre');
const tmpDir = join(vendorDir, '_jre_extract');
const javaExe = join(jreDir, 'bin', 'java.exe');

const DEFAULT_URL =
  process.env.ADOPTIUM_JRE_URL ||
  'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk';

async function fetchWithRetry(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      const wait = 3000 * (i + 1);
      console.warn(`[download-jre] 第 ${i + 1} 次下载失败，${wait}ms 后重试:`, e.message || e);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main() {
  if (process.env.SKIP_JRE_DOWNLOAD === '1') {
    console.log('[download-jre] SKIP_JRE_DOWNLOAD=1，跳过。');
    return;
  }
  if (existsSync(javaExe)) {
    console.log('[download-jre] 已存在', javaExe);
    return;
  }

  mkdirSync(vendorDir, { recursive: true });
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(jreDir, { recursive: true, force: true });

  const zipPath = join(vendorDir, 'temurin-jre-win.zip');
  console.log('[download-jre] 正在下载', DEFAULT_URL);

  const res = await fetchWithRetry(DEFAULT_URL);

  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(zipPath, buf);
  console.log('[download-jre] 已保存', zipPath, '大小', buf.length);

  const zip = new AdmZip(zipPath);
  mkdirSync(tmpDir, { recursive: true });
  zip.extractAllTo(tmpDir, true);

  const top = readdirSync(tmpDir).filter((name) => {
    try {
      return statSync(join(tmpDir, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (top.length !== 1) {
    throw new Error(`[download-jre] 解压后根目录异常: ${top.join(', ')}`);
  }

  renameSync(join(tmpDir, top[0]), jreDir);
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });

  if (!existsSync(javaExe)) {
    throw new Error('[download-jre] 未找到 bin/java.exe，请检查压缩包结构');
  }
  console.log('[download-jre] 完成', javaExe);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
