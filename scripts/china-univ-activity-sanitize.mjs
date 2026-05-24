/**
 * 国内高校 A 类活动图：` :开始;` ` :结束;` 按专规不应带 stereotype，
 * 但模型常与错误示例对齐误加 <<task>>，此处统一剥除。
 *
 * @param {string} puml
 */
export function stripChinaUnivActivityStartEndStereotypes(puml) {
  const rx = /^(\s*):(开始|结束);\s*((?:<<[^>\r\n]+>>(?:[\t ])*)+)/gm;
  return String(puml || '').replace(rx, (_m, ws, kw) => `${ws}:${kw};`);
}
