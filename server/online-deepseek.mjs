/**
 * 网页端「自然语言 → PlantUML」：通过 .env 配置 DeepSeek 兼容的 Chat Completions API。
 *
 * 环境变量：
 * - STUDIO_ONLINE_DEEPSEEK_API_KEY（必填方可启用）
 * - STUDIO_ONLINE_DEEPSEEK_BASE_URL（可选，默认 https://api.deepseek.com）
 * - STUDIO_ONLINE_DEEPSEEK_MODEL（可选，默认 deepseek-chat）
 */

function getApiKey() {
  return (process.env.STUDIO_ONLINE_DEEPSEEK_API_KEY || '').trim();
}

function getBaseUrl() {
  return (process.env.STUDIO_ONLINE_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim().replace(/\/$/, '');
}

function getModel() {
  return (process.env.STUDIO_ONLINE_DEEPSEEK_MODEL || 'deepseek-chat').trim();
}

const NL_SYSTEM = [
  '你是 PlantUML 专家。用户用中文或英文描述要画的 UML / 架构图。',
  '你必须只输出一段完整、可被 PlantUML 渲染的源码。',
  '优先使用 @startuml 与 @enduml；若用户明确要求 ER 且适合用 Chen 记号，可使用 @startchen / @endchen。',
  '不要输出 Markdown 解释段落；如需简短说明，请用 PlantUML 的 note / legend 写在图内。',
  '避免使用需要本地文件或网络资源的非标准插件；保持语法在常见 PlantUML 版本下可渲染。',
].join('\n');

export function isOnlineDeepseekConfigured() {
  return Boolean(getApiKey());
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function flattenFetchRelatedMessage(e) {
  const parts = [];
  const push = (s) => {
    const t = String(s || '').trim();
    if (t) parts.push(t);
  };
  if (e && typeof e === 'object' && 'message' in e) push(e.message);
  else push(e);
  let cur = e;
  for (let depth = 0; cur != null && depth < 8; depth++) {
    if (cur instanceof AggregateError && Array.isArray(cur.errors)) {
      for (const sub of cur.errors) push(sub?.message || sub);
      break;
    }
    cur = cur && typeof cur === 'object' && 'cause' in cur ? cur.cause : null;
    if (cur && typeof cur === 'object' && 'message' in cur) push(cur.message);
  }
  return parts.join(' | ') || '未知错误';
}

function isTransientFailure(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    /fetch failed|failed to fetch|networkerror|econnreset|etimedout|econnrefused|enotfound|eai_again|socket hang up|und_err|aborted|reset by peer|tls|ssl|certificate|eof/i.test(
      m
    ) || /timeout|timed out/i.test(m)
  );
}

/**
 * 从模型回复中取出 PlantUML（与桌面端逻辑对齐的精简版）。
 * @param {string} text
 */
export function extractPlantumlFromModelText(text) {
  if (!text || typeof text !== 'string') return '';
  const fenceRe = /```(?:plantuml|puml|uml)?\s*([\s\S]*?)```/gi;
  const fencedBodies = [];
  let fm;
  while ((fm = fenceRe.exec(text)) !== null) {
    fencedBodies.push(fm[1].trim());
  }
  for (let i = fencedBodies.length - 1; i >= 0; i--) {
    const inner = fencedBodies[i];
    const m = inner.match(/@start[\w]*[\s\S]*?@end[\w]*/i);
    if (m) return m[0].trim();
    if (inner.includes('@start')) return inner;
  }
  const nakedRe = /@start[\w]*[\s\S]*?@end[\w]*/gi;
  let lastNaked = null;
  let nm;
  while ((nm = nakedRe.exec(text)) !== null) {
    lastNaked = nm[0];
  }
  if (lastNaked) return lastNaked.trim();
  return text.trim();
}

async function chatCompletions(messages, options = {}) {
  const API_KEY = getApiKey();
  const BASE_URL = getBaseUrl();
  const MODEL = getModel();
  if (!API_KEY) {
    throw new Error('未配置 STUDIO_ONLINE_DEEPSEEK_API_KEY');
  }
  const url = `${BASE_URL}/v1/chat/completions`;
  const temperature =
    typeof options.temperature === 'number' && Number.isFinite(options.temperature)
      ? Math.min(1.5, Math.max(0, options.temperature))
      : 0.25;
  const maxAttempts = Math.max(1, Math.min(6, Number(options.fetchMaxAttempts) || 4));
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(8000, Math.min(180000, options.timeoutMs))
      : 90000;
  const body = JSON.stringify({
    model: MODEL,
    messages,
    temperature,
  });

  let lastFlat = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(t);

      if (!res.ok) {
        const t2 = await res.text();
        const flatHttp = `HTTP ${res.status}: ${t2.slice(0, 800)}`;
        lastFlat = flatHttp;
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(res.status);
        if (retryable && attempt < maxAttempts) {
          const delay = Math.min(12_000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
          await sleepMs(delay);
          continue;
        }
        throw new Error(`DeepSeek 请求失败 ${flatHttp}`);
      }

      const j = await res.json();
      const content = j.choices?.[0]?.message?.content;
      if (!content) throw new Error('DeepSeek 响应无有效内容');
      return String(content);
    } catch (e) {
      clearTimeout(t);
      const name = e && typeof e === 'object' ? e.name : '';
      const flat = flattenFetchRelatedMessage(e);
      lastFlat = flat;

      if (name === 'AbortError' || /\babort(ed)?\b/i.test(flat)) {
        throw new Error(`DeepSeek 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }

      const transient =
        isTransientFailure(flat) ||
        (e && typeof e === 'object' && isTransientFailure(String(e.cause?.message || '')));

      if (transient && attempt < maxAttempts) {
        const delay = Math.min(12_000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
        await sleepMs(delay);
        continue;
      }

      const hint =
        '请检查：1) STUDIO_ONLINE_DEEPSEEK_BASE_URL 是否可达 2) 防火墙/代理 3) API Key 是否有效 4) 模型名是否正确。';
      throw new Error(`${flat}\n\n${hint}`);
    }
  }

  throw new Error(lastFlat || 'DeepSeek 请求失败');
}

/**
 * @param {string} userText
 * @returns {Promise<string>} PlantUML 源码
 */
export async function generatePlantumlFromNaturalLanguage(userText) {
  const raw = await chatCompletions(
    [
      { role: 'system', content: NL_SYSTEM },
      { role: 'user', content: `请根据以下需求输出 PlantUML 源码：\n\n${userText}` },
    ],
    { temperature: 0.25, fetchMaxAttempts: 4, timeoutMs: 90000 }
  );
  const extracted = extractPlantumlFromModelText(raw);
  return extracted;
}
