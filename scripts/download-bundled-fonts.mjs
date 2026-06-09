/**
 * 下载可再发行的中文开源字体（OFL）到 vendor/fonts/，供安装包 extraResources 打包。
 * 跳过：已有 .ttf/.otf，或 SKIP_FONTS_DOWNLOAD=1
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'vendor', 'fonts');

const FONT_ASSETS = [
  {
    file: 'NotoSansSC[wght].ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
  },
  {
    file: 'NotoSerifSC[wght].ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf',
  },
  {
    file: 'OFL-NotoSansSC.txt',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt',
  },
  {
    file: 'OFL-NotoSerifSC.txt',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/OFL.txt',
  },
];

function hasFontFiles() {
  if (!existsSync(outDir)) return false;
  return readdirSync(outDir).some((f) => /\.(ttf|otf)$/i.test(f));
}

async function fetchWithRetry(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  if (process.env.SKIP_FONTS_DOWNLOAD === '1') {
    console.log('[download-fonts] SKIP_FONTS_DOWNLOAD=1，跳过。');
    return;
  }
  if (hasFontFiles()) {
    console.log('[download-fonts] vendor/fonts 已有字体文件，跳过。');
    return;
  }

  mkdirSync(outDir, { recursive: true });
  for (const asset of FONT_ASSETS) {
    const dest = join(outDir, asset.file);
    if (existsSync(dest)) {
      console.log('[download-fonts] 已存在', asset.file);
      continue;
    }
    console.log('[download-fonts] 下载', asset.file);
    const buf = await fetchWithRetry(asset.url);
    writeFileSync(dest, buf);
    console.log('[download-fonts] 已保存', dest, buf.length, 'bytes');
  }
}

main().catch((e) => {
  console.error('[download-fonts] 失败:', e);
  process.exit(1);
});
