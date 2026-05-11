/**
 * 编辑器语法路由：识别 @studio-arch 与 PlantUML 等块，供渲染与 Agent 分流。
 */

/** @typedef {'plantuml'|'studio-arch'} DiagramKind */

/**
 * @param {string} text
 * @returns {{ kind: DiagramKind, archBlock: string, plantumlSource: string }}
 */
export function parseEditorDocument(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trimStart();
  if (!/^@studio-arch\b/i.test(trimmed)) {
    return { kind: 'plantuml', archBlock: '', plantumlSource: raw };
  }
  const mEnd = /^@endstudio-arch\s*$/im.exec(trimmed);
  let archEndIdx = -1;
  if (mEnd && mEnd.index != null) archEndIdx = mEnd.index + mEnd[0].length;
  const archBlock = archEndIdx >= 0 ? trimmed.slice(0, archEndIdx).trim() : trimmed.trim();
  const rest = archEndIdx >= 0 ? trimmed.slice(archEndIdx).trim() : '';
  return {
    kind: 'studio-arch',
    archBlock,
    plantumlSource: rest || '@startuml\n@enduml',
  };
}
