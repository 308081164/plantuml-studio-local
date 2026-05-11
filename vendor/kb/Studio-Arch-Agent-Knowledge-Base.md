# Studio 静态架构图（@studio-arch）知识库

本知识库与 PlantUML 制图知识库 **独立维护**：专用于「仓库静态可推」的模块/依赖说明，避免与 UML 皮肤参数、活动图国标等规则混淆。

## 0. 模式与用户定位

- 输出物仅为 `@studio-arch` … `@endstudio-arch` 之间的 **YAML**，由本地渲染器结合清单扫描生成 **黑白灰 SVG**。
- 禁止臆造清单中不存在的路径；`focus_paths` 必须是真实 `path` 的前缀（与 JSONL 清单一致）。
- 不向用户承诺运行时行为、张量形状或 GPU 占用；只描述 **文件级 / 包级** 结构。

## 1. 静态信息来源

- 主进程会注入 **项目文件清单 JSONL**（`path` 字段）。所有「重点模块」必须能在该清单中找到依据。
- 本地边提取规则（与渲染器一致，勿与之矛盾）：
  - Python：`from x.y import`、`import a`（解析为仓库内可解析的 `.py` / `__init__.py`）。
  - JS/TS：`import … from './相对路径'`（仅相对路径，不含 `node_modules`）。
- 外部依赖（标准库、`node_modules`、PyPI 未纳入仓库的包）**不要**作为节点写入 YAML；可在 `notes` 中用一句话说明「存在外部依赖未画出」。

## 2. YAML 字段约定

- `title`：单行中文或英文标题。
- `focus_paths`：字符串数组，每项为 posix 风格相对路径前缀，如 `renderer`、`scripts/studio-arch-graph.mjs` 的父目录等。
- `notes`：可选，单行；用于说明扫描上限、语言范围或「边仅含相对 import」等限制。

## 3. 视觉与配色（语义层）

- 最终图由渲染器强制为 **黑 / 灰 / 白**：节点浅灰底、深灰或黑描边、连线中灰。
- 你在 YAML 中 **不得** 建议任何彩色主题、渐变、emoji 或高亮语义色（如红绿状态）。

## 4. 与 PlantUML 的边界

- 本模式 **不** 输出 `@startuml`，不输出 `skinparam`、`component` 等 PlantUML 语法。
- 若用户需求其实是时序图/用例图，应在心中判断：应提示其使用左侧 PlantUML 智能生成，而不是输出 `@studio-arch`。

## 5. 自检清单（模型输出前）

- [ ] 是否仅有 `@studio-arch` / `@endstudio-arch` 包裹的 YAML？
- [ ] `focus_paths` 是否均能在清单 `path` 中找到前缀匹配？
- [ ] `title` + `notes` 是否未引入彩色、未捏造未列出路径？

## 6. 示例（结构示意，勿照搬虚构路径）

```text
@studio-arch
title: 示例服务分层
focus_paths:
  - src/api
  - src/core
notes: 边仅含仓库内 Python/JS 相对 import；外部库未展开。
@endstudio-arch
```
