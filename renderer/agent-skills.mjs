/** 制图技能：/+ 唤起；高校模式条目使用渐变背景与小演示配图（renderer/assets/agent-skill-previews） */

function svgDataUrl(inner) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="56" viewBox="0 0 96 56">${inner}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function previewAsset(file) {
  return new URL(`./assets/agent-skill-previews/${file}`, import.meta.url).href;
}

export const DRAWING_AGENT_SKILLS = [
  {
    id: 'cn-activity',
    univPriority: true,
    label: '国标活动流程图',
    desc: '高校模式 · GB/T1526 · @startuml activity',
    preview: previewAsset('cn-activity.svg'),
    menuTone: 'univ-act',
    chipTone: 'univ-act',
    snippet:
      '请绘制「国内高校国标」程序/业务流程图（@startuml activity）：开始/结束为 :开始; / :结束;，判断用菱形 if 分支；说明业务：\n',
  },
  {
    id: 'cn-wbs',
    univPriority: true,
    label: 'WBS 功能结构图',
    desc: '高校模式 · 系统功能架构 · @startwbs',
    preview: previewAsset('cn-wbs.svg'),
    menuTone: 'univ-wbs',
    chipTone: 'univ-wbs',
    snippet:
      '请绘制「系统功能结构图 / WBS」（@startwbs）：根节点→子系统→功能清单，白底方框示意；主题是：\n',
  },
  {
    id: 'cn-chen-er',
    univPriority: true,
    label: '陈氏 ER 图',
    desc: '高校模式 · @startchen',
    preview: previewAsset('cn-chen-er.svg'),
    menuTone: 'univ-er',
    chipTone: 'univ-er',
    snippet: '请用 @startchen 陈氏 ER 图描述实体关系，领域是：\n',
  },
  {
    id: 'sequence',
    univPriority: false,
    label: 'UML 时序图',
    desc: '@startuml … sequence …',
    chipTone: 'neutral',
    preview: svgDataUrl(`
  <line x1="16" y1="52" x2="16" y2="8" stroke="#999"/><line x1="48" y1="52" x2="48" y2="8" stroke="#999"/><line x1="80" y1="52" x2="80" y2="8" stroke="#999"/>
  <path d="M16 20h42M58 26l8-6-8-6" stroke="#111"/><path d="M48 36h42" stroke="#111" marker-end="url(#a)" />
  <defs><marker id="a" markerWidth="6" markerHeight="6" refX="4" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="#111"/></marker></defs>`),
    snippet:
      '请画 UML 时序图（sequence），参与者与交互要点：\n',
  },
  {
    id: 'class-diagram',
    univPriority: false,
    label: 'UML 类图',
    desc: '@startuml class',
    chipTone: 'neutral',
    preview: svgDataUrl(`
  <rect x="20" y="10" width="56" height="36" rx="2" fill="#fff" stroke="#111"/>
  <line x1="22" y1="22" x2="74" y2="22" stroke="#111"/>
  <line x1="22" y1="32" x2="74" y2="32" stroke="#111"/>`),
    snippet:
      '请画 UML 类图，领域/类清单：\n',
  },
  {
    id: 'use-case',
    univPriority: false,
    label: '用例图',
    desc: '@startuml usecase',
    chipTone: 'neutral',
    preview: svgDataUrl(`
  <ellipse cx="48" cy="28" rx="28" ry="14" fill="#fff" stroke="#111"/>
  <circle cx="18" cy="28" r="5" fill="none" stroke="#111"/>`),
    snippet:
      '请画用例图，系统边界与参与者：\n',
  },
  {
    id: 'state',
    univPriority: false,
    label: '状态图',
    desc: '@startuml state',
    chipTone: 'neutral',
    preview: svgDataUrl(`
  <circle cx="20" cy="28" r="6" stroke="#111" fill="#fff"/><rect x="40" y="22" width="24" height="12" rx="2" stroke="#111" fill="#fff"/>
  <path d="M26 28h12M64 28h8" stroke="#111"/>`),
    snippet:
      '请画 UML 状态图，描述状态与迁移：\n',
  },
  {
    id: 'component',
    univPriority: false,
    label: '组件图',
    desc: '@startuml component',
    chipTone: 'neutral',
    preview: svgDataUrl(`
  <rect x="18" y="16" width="60" height="24" rx="2" stroke="#111" fill="#fff"/>
  <path d="M22 38h52" stroke="#111"/>`),
    snippet:
      '请画组件/部署视图：\n',
  },
];

/**
 * @param {boolean} chinaUniv
 */
export function sortSkillsForMenu(chinaUniv) {
  const copy = DRAWING_AGENT_SKILLS.slice();
  if (!chinaUniv) return copy.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  return copy.sort((a, b) => {
    if (a.univPriority && !b.univPriority) return -1;
    if (!a.univPriority && b.univPriority) return 1;
    return a.label.localeCompare(b.label, 'zh-CN');
  });
}
