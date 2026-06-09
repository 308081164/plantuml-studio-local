/**
 * 预览区字体：在渲染/导出前向 PlantUML 源码注入 skinparam defaultFontName。
 * 「安装包内置」项依赖 bundled-fonts-runtime 将 Noto 字体注册到捆绑 JRE；
 * 系统字体项依赖 Windows 已安装字体。
 */

/** @type {{ id: string, label: string, name: string, bundled?: boolean }[]} */
export const PREVIEW_FONT_PRESETS = [
  { id: '', label: '默认（跟随源码）', name: '' },
  { id: 'noto-sans-bundled', label: '思源黑体（安装包内置）', name: 'Noto Sans SC', bundled: true },
  { id: 'noto-serif-bundled', label: '思源宋体（安装包内置）', name: 'Noto Serif SC', bundled: true },
  { id: 'simsun', label: '宋体（系统）', name: 'SimSun' },
  { id: 'simhei', label: '黑体（系统）', name: 'SimHei' },
  { id: 'yahei', label: '微软雅黑（系统）', name: 'Microsoft YaHei' },
  { id: 'kaiti', label: '楷体（系统）', name: 'KaiTi' },
  { id: 'fangsong', label: '仿宋（系统）', name: 'FangSong' },
  { id: 'arial', label: 'Arial（系统）', name: 'Arial' },
];

export const DEFAULT_BUNDLED_PREVIEW_FONT_ID = 'noto-sans-bundled';

const DIAGRAM_START_RE = /@(startuml|startchen|startwbs)\b/i;
const DEFAULT_FONT_LINE_RE = /^\s*skinparam\s+defaultFontName\s+[^\n]+\n?/gim;

/**
 * @param {string} source
 * @param {string} fontId PREVIEW_FONT_PRESETS[].id
 */
export function applyPreviewFontToSource(source, fontId) {
  const preset = PREVIEW_FONT_PRESETS.find((p) => p.id === fontId);
  if (!preset?.name) return String(source ?? '');

  const raw = String(source ?? '');
  const startMatch = raw.match(DIAGRAM_START_RE);
  if (!startMatch || startMatch.index == null) return raw;

  const cleaned = raw.replace(DEFAULT_FONT_LINE_RE, '');
  const insertAt = startMatch.index + startMatch[0].length;
  const injection = `\nskinparam defaultFontName "${preset.name}"\n`;
  return cleaned.slice(0, insertAt) + injection + cleaned.slice(insertAt);
}
