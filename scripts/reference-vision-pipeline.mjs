/**
 * 参考图混合流水线：千问 VL 结构化理解/视觉比对 + DeepSeek 写 PlantUML 的共享文案与工具。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const QWEN_VISION_ANALYSIS_SYSTEM_BASE = [
  '你是软件工程制图「参考图」结构化分析专家。用户会提供截图、教材插图、白板或手绘示意图。',
  '你的输出将交给 **仅处理文本** 的 PlantUML 生成模型；你必须用 **固定表格/列表** 描述拓扑与形状，禁止用散文模糊带过。',
  '',
  '【硬性规则】',
  '1) 看不清的内容写 UNCLEAR，禁止猜测形状或连线。',
  '2) 每个可见框/节点分配唯一 ID：N1、N2、N3…',
  '3) 每条连线单独一行，分配 E1、E2…，禁止合并描述。',
  '4) 必须区分 rectangle（矩形）与 parallelogram（平行四边形）；菱形用 diamond。',
  '5) 默认不要输出完整 PlantUML 源码。',
  '',
  '【必须输出的章节（按顺序）】',
  '',
  '## 图类判定',
  '类型：（UML时序/类/组件/用例/状态/活动流程/Chen ER/WBS/混合/其它）',
  '置信度：高/中/低',
  '',
  '## 节点表',
  '| ID | 形状 | 文本 | 位置简述 | 备注 |',
  '| N1 | parallelogram | … | 左上 | … |',
  '',
  '## 连接表',
  '| ID | 从 | 到 | 线型 | 箭头 | 标签 | 置信度 |',
  '| E1 | N1 | N2 | 实线 | 单向→ | 无 | 高 |',
  '',
  '## 图中文字（逐字抄录）',
  '',
  '## 布局与泳道',
  '',
  '## 复刻要点（几何/顺序约束）',
  '若用户要求一比一复刻，列出必须一致的形状与连接顺序。',
].join('\n');

export const QWEN_VISION_COMPARE_SYSTEM = [
  '你是「参考图 vs PlantUML 渲染图」视觉质检专家。用户会提供：',
  '- 图 A：用户原始参考图',
  '- 图 B：由当前 PlantUML 源码渲染出的图',
  '- 附带：用户需求、首轮结构化分析、当前源码摘要',
  '',
  '请对比 A 与 B，找出 **拓扑、形状、连线、文字、布局** 上的差异。',
  '',
  '【输出格式 — 必须严格遵守】',
  '',
  '## 差异结论',
  '显著差异：是/否   （若基本一致、仅字体/间距差异，写 否）',
  '',
  '## 拓扑差异',
  '- 缺失节点/边：…',
  '- 多出节点/边：…',
  '- 连接方向/端点错误：…',
  '',
  '## 形状差异',
  '- 例：N1 参考图为平行四边形，渲染图为矩形',
  '',
  '## 文字与标签差异',
  '',
  '## 布局差异',
  '',
  '## 建议修改（供 DeepSeek 改 PlantUML）',
  '用条目列出应对 PlantUML 做的具体改动；若显著差异为否，写「无需修改」。',
  '',
  '禁止输出完整 PlantUML，只做差异报告。',
].join('\n');

export const VISUAL_FIX_DEEPSEEK_APPEND = [
  '',
  '===== 【参考图视觉修正模式】 =====',
  '用户提供了参考图，且千问已对比参考图与当前渲染结果并给出差异报告。',
  '你必须：',
  '1) 优先按「视觉差异报告」与「建议修改」修订源码，修正缺边、错形、错标签。',
  '2) 同时遵守【附图理解】中的节点表与连接表，不得删除已正确的部分。',
  '3) 形状映射：平行四边形输入/输出 → <<save>>；矩形处理 → <<task>>；判定 → if/else。',
  '4) 输出完整、可本地渲染的 PlantUML 源码（@start… @end）。',
].join('\n');

/**
 * @param {string} [kbExcerpt]
 */
export function buildVisionAnalysisSystemPrompt(kbExcerpt) {
  const kb = String(kbExcerpt || '').trim();
  if (!kb) return QWEN_VISION_ANALYSIS_SYSTEM_BASE;
  return `${QWEN_VISION_ANALYSIS_SYSTEM_BASE}\n\n【视觉分析知识库摘录】\n${kb}`;
}

/**
 * @param {string} compareText
 * @returns {boolean}
 */
export function shouldContinueVisualCorrection(compareText) {
  const t = String(compareText || '').trim();
  if (!t) return false;
  if (/显著差异\s*[：:]\s*否/.test(t)) return false;
  if (/无显著差异|基本一致|无需修改|无需修正/.test(t)) return false;
  if (/显著差异\s*[：:]\s*是/.test(t)) return true;
  if (/(缺失|缺少|多出|错误|应为|不对|不一致).{0,30}(边|节点|连接|箭头|形状|矩形|平行四边形|菱形)/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * @param {object} p
 * @param {number} p.visualRound
 * @param {number} p.maxVisualRounds
 * @param {string} p.baseUserText
 * @param {string} p.visionBrief
 * @param {string} p.visualDiffReport
 * @param {string} p.source
 * @param {string} [p.editorSource]
 */
export function buildVisualFixUserContent(p) {
  const editorBlock =
    p.editorSource && String(p.editorSource).trim()
      ? `【编辑器现有源码（可参考）】\n\`\`\`plantuml\n${String(p.editorSource).slice(0, 8000)}\n\`\`\`\n\n`
      : '';
  const folded =
    String(p.source || '').length > 12000
      ? `${String(p.source).slice(0, 6000)}\n\n/* …中间省略… */\n\n${String(p.source).slice(-4000)}`
      : String(p.source || '');
  return `${editorBlock}【参考图视觉修正 — 第 ${p.visualRound}/${p.maxVisualRounds} 轮】

【用户原始需求】
${String(p.baseUserText || '').trim()}

【首轮附图结构化理解（摘要）】
${String(p.visionBrief || '').slice(0, 6000)}

【千问视觉差异报告（参考图 vs 当前渲染图）】
${String(p.visualDiffReport || '').trim()}

【当前 PlantUML 源码（须在此基础上修订）】
\`\`\`plantuml
${folded}
\`\`\`

请根据差异报告输出 **修订后的完整 PlantUML 源码**（整段替换，勿只给 diff）。`;
}

/**
 * @param {string[]} candidates
 * @param {number} [maxChars]
 */
export function readVisionKbExcerptFromCandidates(candidates, maxChars = 4000) {
  const limit = Math.max(500, Number(maxChars) || 4000);
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      return raw.length <= limit ? raw : `${raw.slice(0, limit)}\n…（知识库已截断）`;
    } catch {
      /* try next */
    }
  }
  return '';
}

/** @param {string} resourcesPath */
export function visionKbCandidatePaths(resourcesPath = '') {
  return [
    join(resourcesPath || '', 'kb', 'Vision-Reference-Analysis-KB.md'),
    join(__dirname, '..', 'vendor', 'kb', 'Vision-Reference-Analysis-KB.md'),
    join(__dirname, '..', 'Vision-Reference-Analysis-KB.md'),
  ];
}
