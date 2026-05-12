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

function wire() {
  const ta = $('plantuml-source');
  if (ta && !ta.value.trim()) ta.value = DEFAULT_SOURCE;

  $('btn-render')?.addEventListener('click', () => renderPlantuml());

  $('btn-load-sample')?.addEventListener('click', () => {
    if (ta) ta.value = DEFAULT_SOURCE;
    setPreview('', false);
  });

  document.querySelectorAll('a[data-jump="convert"]').forEach((link) => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      document.getElementById('convert')?.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

document.addEventListener('DOMContentLoaded', wire);
