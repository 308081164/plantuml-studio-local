/**
 * 安装包内置字体：解析目录、同步到捆绑 JRE、生成 JVM 参数。
 * PlantUML 通过 JVM GraphicsEnvironment 识别字体名（skinparam defaultFontName）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** @typedef {{ id: string, label: string, plantumlName: string, bundled: boolean }} BundledFontPreset */

/** 与 renderer/scripts/plantuml-font.mjs 中 bundled 项保持一致 */
export const BUNDLED_FONT_PRESETS = [
  { id: 'noto-sans-bundled', label: '思源黑体（安装包内置）', plantumlName: 'Noto Sans SC', bundled: true },
  { id: 'noto-serif-bundled', label: '思源宋体（安装包内置）', plantumlName: 'Noto Serif SC', bundled: true },
];

export const DEFAULT_BUNDLED_PREVIEW_FONT_ID = 'noto-sans-bundled';

/**
 * @param {{ resourcesPath?: string, appDirname: string, isPackaged: boolean }} ctx
 */
export function resolveBundledFontsDir(ctx) {
  if (ctx.isPackaged) return join(ctx.resourcesPath || '', 'fonts');
  return join(ctx.appDirname, 'vendor', 'fonts');
}

export function bundledFontsAvailable(fontsDir) {
  if (!fontsDir || !existsSync(fontsDir)) return false;
  try {
    return readdirSync(fontsDir).some((f) => /\.(ttf|otf|ttc)$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * 将字体复制到捆绑 JRE 的 lib/fonts（Windows fontconfig 优先查找）。
 * @param {string} javaExe
 * @param {string} fontsDir
 */
export function syncBundledFontsToJre(javaExe, fontsDir) {
  if (!bundledFontsAvailable(fontsDir)) return 0;
  const jreHome = dirname(dirname(javaExe));
  const target = join(jreHome, 'lib', 'fonts');
  mkdirSync(target, { recursive: true });
  let n = 0;
  for (const f of readdirSync(fontsDir)) {
    if (!/\.(ttf|otf|ttc)$/i.test(f)) continue;
    copyFileSync(join(fontsDir, f), join(target, f));
    n += 1;
  }
  return n;
}

/**
 * @param {string} javaExe
 * @param {string} fontsDir
 * @returns {string[]}
 */
export function buildJavaFontJvmArgs(javaExe, fontsDir) {
  if (!bundledFontsAvailable(fontsDir)) return [];
  syncBundledFontsToJre(javaExe, fontsDir);
  const normalized = String(fontsDir).replace(/\\/g, '/');
  return [`-Dsun.java2d.fontpath=${normalized}`];
}
