/**
 * 免费版：智能生成结果会话锁定（占位文案与检测）
 * 真实 PlantUML 源码仅保留在主进程内存中，直至支付解锁或激活专业版。
 */

export const LOCK_MARKER = '<<STUDIO_AGENT_LOCK>>\n';

export function buildLockedEditorPlaceholder() {
  return `${LOCK_MARKER}【免费版 · 智能生成】PlantUML 源码已受保护，预览含水印。请使用工具栏「支付解锁本条」或菜单「帮助 → 授权激活」以恢复编辑、导出与暂存。\n\n您可删除本框内全部文字后自行编写 PlantUML（手写制图不受限）。`;
}

export function isLockedPlaceholderText(text) {
  return typeof text === 'string' && text.startsWith(LOCK_MARKER);
}
