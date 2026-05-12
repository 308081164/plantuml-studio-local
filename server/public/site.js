/* global document */

const DEFAULT_SOURCE = `@startuml
title PlantUML 本地工作室 — 在线预览示例
actor 用户 as u
participant "桌面客户端" as c
participant "本站 :8848" as s
participant "PlantUML\\n在线服务" as k

u -> c : 自然语言 / 项目制图
c -> s : 支付与元数据（可选）
u -> s : 浏览器内粘贴源码
s -> k : 编码后请求 SVG
k --> s : SVG
s --> u : 本页预览
@enduml`;

function $(id) {
  return document.getElementById(id);
}

function setPreview(html, isError) {
  const el = $('preview-mount');
  if (!el) return;
  el.innerHTML = '';
  el.classList.remove('preview-error');
  if (isError) {
    const p = document.createElement('pre');
    p.className = 'preview-error';
    p.textContent = html;
    el.appendChild(p);
    return;
  }
  if (!html) {
    const p = document.createElement('div');
    p.className = 'preview-placeholder';
    p.textContent = '点击「渲染预览」生成 SVG';
    el.appendChild(p);
    return;
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const svg = wrap.querySelector('svg');
  if (svg) el.appendChild(svg);
  else {
    const p = document.createElement('pre');
    p.className = 'preview-error';
    p.textContent = '返回内容不是有效 SVG';
    el.appendChild(p);
  }
}

async function renderPlantuml() {
  const ta = $('plantuml-source');
  const btn = $('btn-render');
  const source = ta ? ta.value : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '渲染中…';
  }
  setPreview('', false);
  try {
    const res = await fetch('/api/convert/plantuml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setPreview(data.error || data.detail || `请求失败 HTTP ${res.status}`, true);
      return;
    }
    setPreview(data.svg || '', false);
  } catch (e) {
    setPreview(String(e.message || e), true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '渲染预览';
    }
  }
}

async function refreshOnlineAiStatus() {
  const line = $('nl-status-line');
  const panel = $('nl-panel');
  try {
    const res = await fetch('/api/public/online-ai');
    const data = await res.json().catch(() => ({}));
    const ok = Boolean(data?.deepseekConfigured);
    if (line) {
      line.hidden = false;
      line.classList.toggle('nl-status-line--ok', ok);
      line.textContent = ok
        ? '已检测到服务端 DeepSeek 配置：可使用下方「自然语言 → PlantUML」。'
        : '未检测到 STUDIO_ONLINE_DEEPSEEK_API_KEY：自然语言生成不可用，仍可使用左侧「源码渲染预览」。';
    }
    if (panel) {
      panel.classList.toggle('nl-panel--disabled', !ok);
    }
  } catch {
    if (line) {
      line.hidden = false;
      line.classList.remove('nl-status-line--ok');
      line.textContent = '无法读取 /api/public/online-ai，请检查网络或服务是否运行。';
    }
  }
}

async function runNlConvert(renderSvg) {
  const ta = $('plantuml-source');
  const nlTa = $('nl-user-text');
  const userText = nlTa ? nlTa.value.trim() : '';
  if (!userText) {
    setPreview('请先在「自然语言」框中输入描述', true);
    return;
  }
  const btnA = $('btn-nl-source-only');
  const btnB = $('btn-nl-generate-render');
  const busy = (on) => {
    if (btnA) btnA.disabled = on;
    if (btnB) btnB.disabled = on;
  };
  busy(true);
  if (!renderSvg) setPreview('', false);
  try {
    const res = await fetch('/api/convert/plantuml-nl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userText, renderSvg }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 503 && data.code === 'deepseek_not_configured') {
      setPreview(data.error || '服务端未配置 DeepSeek', true);
      await refreshOnlineAiStatus();
      return;
    }
    if (!res.ok || !data.ok) {
      setPreview(data.error || data.detail || `请求失败 HTTP ${res.status}`, true);
      return;
    }
    if (ta && data.plantuml) ta.value = data.plantuml;
    if (renderSvg) {
      if (data.svg) setPreview(data.svg, false);
      else {
        const warn = [data.renderWarning, data.renderDetail].filter(Boolean).join('\n');
        setPreview(warn || '已生成源码，但在线渲染失败（可点击「渲染预览」重试）', true);
      }
    } else {
      setPreview('', false);
    }
  } catch (e) {
    setPreview(String(e.message || e), true);
  } finally {
    busy(false);
  }
}

function wire() {
  const ta = $('plantuml-source');
  if (ta && !ta.value.trim()) ta.value = DEFAULT_SOURCE;

  $('btn-render')?.addEventListener('click', () => renderPlantuml());

  $('btn-load-sample')?.addEventListener('click', () => {
    if (ta) ta.value = DEFAULT_SOURCE;
    setPreview('', false);
  });

  $('btn-nl-source-only')?.addEventListener('click', () => runNlConvert(false));
  $('btn-nl-generate-render')?.addEventListener('click', () => runNlConvert(true));

  document.querySelectorAll('a[data-jump="convert"]').forEach((link) => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      document.getElementById('convert')?.scrollIntoView({ behavior: 'smooth' });
    });
  });

  refreshOnlineAiStatus();
}

document.addEventListener('DOMContentLoaded', wire);
