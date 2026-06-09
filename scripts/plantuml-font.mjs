/**
 * 预览区字体：在渲染/导出前向 PlantUML 源码注入 skinparam defaultFontName。
 * 依赖本机已安装对应字体（Windows 常见：SimSun / SimHei / Microsoft YaHei 等）。
 */

/** @type {{ id: string, label: string, name: string }[]} */
export const PREVIEW_FONT_PRESETS = [
  { id: '', label: '默认（跟随源码）', name: '' },
  { id: 'simsun', label: '宋体', name: 'SimSun' },
  { id: 'simhei', label: '黑体', name: 'SimHei' },
  { id: 'yahei', label: '微软雅黑', name: 'Microsoft YaHei' },
  { id: 'kaiti', label: '楷体', name: 'KaiTi' },
  { id: 'fangsong', label: '仿宋', name: 'FangSong' },
  { id: 'arial', label: 'Arial', name: 'Arial' },
];

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
