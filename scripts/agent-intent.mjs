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
 * 用户描述是否明显指向「静态架构 / @studio-arch」草稿（供 UI 提示，可选）。
 * @param {string} userText
 */
export function wantsArchitectureArchDraft(userText) {
  const zh = String(userText || '');
  return /@studio-arch|静态架构|依赖图|模块结构|包依赖|import\s*关系|代码结构图|仓库依赖/i.test(zh);
}

/**
 * 在**已具备项目根路径**时，是否值得走「结合仓库选文件 + 读源码摘要」的项目制图管线。
 *
 * **说明（与「自主选择有用信息」的关系）**
 * - 本函数只用**轻量规则**（关键词、路径形态等），**不是**第二次让 AI 判断「是否与项目相关」；
 *   目的是避免「纯抽象 UML 描述」仍扫描整仓库、浪费 token 与时间。
 * - 一旦进入项目管线，**选哪些文件**仍由现有逻辑负责：先调用 DeepSeek 规划器从清单里选 `paths`，
 *   失败再回退启发式；随后才把选中文件正文拼进提示词——这一段才是「有选择地读项目信息」。
 *
 * @param {string} userText
 */
export function wantsProjectCodeContext(userText) {
  const zh = String(userText || '').trim();
  if (!zh) return false;

  // 静态架构 / @studio-arch 由独立 IPC 处理，不走 PlantUML 项目管线
  if (wantsArchitectureArchDraft(zh)) return false;

  if (
    /(仓库|代码库|工程目录|项目根|本仓库|本项目|该项目|当前项目|工作区|workspace|codebase|源码树|扫描项目|遍历目录|根据项目|结合项目|分析项目|项目内|项目里|包结构|模块划分|目录结构|monorepo)/i.test(
      zh
    )
  ) {
    return true;
  }
  if (
    /(依赖|调用链|引用关系|\bimport\b|\bfrom\s+['"]|require\(|模块边界|分层架构|耦合|哪个文件|哪份源码|对应类|对应函数|实现在|定义在|源码在)/i.test(
      zh
    )
  ) {
    return true;
  }
  if (/[/\\][\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|kt|rs|vue|svelte)\b/i.test(zh)) return true;
  if (/\b[\w.-]+[/\\][\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|kt)\b/i.test(zh)) return true;
  if (/\b(src|lib|test|tests|pkg|internal|renderer|electron-main|server|scripts|components?)[/\\]/i.test(zh)) {
    return true;
  }

  return false;
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
