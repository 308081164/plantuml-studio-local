/**
 * 轻量规则意图分类：驱动 KB 路由与国内高校后处理是否改写 @startuml activity
 */

/** @typedef {'chen_er'|'activity_cn_univ'|'sequence'|'class_diag'|'usecase'|'state'|'component'|'gantt'|'other'} DiagramIntent */

/**
 * @param {string} userText
 * @param {boolean} chinaUnivMode
 * @returns {DiagramIntent}
 */
export function classifyDiagramIntent(userText, chinaUnivMode = false) {
  const zh = String(userText || '');

  if (/(?:@startchen|\bER\b|E-?R图?|实体关系|概念模型|数据库\s*设计|陈氏)/i.test(zh)) return 'chen_er';
  if (/时序|序列图|sequence|消息流|调用顺序/i.test(zh)) return 'sequence';
  if (/类图|class\s*diagram|领域模型|domain\s*model/i.test(zh)) return 'class_diag';
  if (/用例图|用例|use\s*case/i.test(zh)) return 'usecase';
  if (/状态图|state\s*chart|状态机/i.test(zh)) return 'state';
  if (/组件图|部署图|component|deployment/i.test(zh)) return 'component';
  if (/甘特|gantt|排期/i.test(zh)) return 'gantt';

  if (chinaUnivMode) {
    if (/流程|活动图|activity|国标|1526|高校|业务流程/i.test(zh)) return 'activity_cn_univ';
  }

  return 'other';
}

/**
 * 国内高校模式是否应对「当前意图」做 @startuml activity 等改写
 * @param {DiagramIntent} intent
 * @param {string} userText
 */
export function shouldApplyChinaUnivPostProcess(intent, userText) {
  const zh = String(userText || '');
  if (intent === 'chen_er') return false;
  if (['sequence', 'class_diag', 'usecase', 'state', 'component', 'gantt'].includes(intent)) return false;
  if (intent === 'activity_cn_univ') return true;
  // other：仅当表述像流程/活动时才改写，避免误伤通用 UML
  if (/流程|活动图|activity|国标|1526|高校|业务流程/i.test(zh)) return true;
  return false;
}
