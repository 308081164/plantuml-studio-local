# PlantUML 本地工作室 (PlantUML Studio Local)

> **本地 PlantUML 编辑预览 + AI 智能生成桌面应用**  
> 基于 Electron + PlantUML PicoWeb 构建，集成 DeepSeek AI 实现自然语言一键制图

![版本](https://img.shields.io/badge/版本-2.0.0--beta.3-blue)
![许可证](https://img.shields.io/badge/许可证-GPL--3.0-green)
![平台](https://img.shields.io/badge/平台-Windows%20x64-lightgrey)

---

## 📖 概述

**PlantUML 本地工作室** 是一款面向开发者和架构师的桌面工具，提供：

- **本地 PlantUML 渲染** — 内置 Java + 官方 PlantUML JAR（PicoWeb 模式），无需联网即可将 PlantUML 源码渲染为 SVG/PNG
- **AI 智能生成** — 集成 DeepSeek API，输入自然语言描述即可自动生成 PlantUML 源码，并经过「生成 → 本地校验 → 自动修正」闭环
- **项目目录驱动制图** — 选择本地工程目录，AI 自动分析项目结构、选取关键文件，结合上下文生成精准的架构图/类图/时序图等
- **产出物管理** — 内置暂存区，支持多图比对、批量管理、一键复制到剪贴板

### 适用场景

- 快速绘制软件架构图、UML 图、流程图、时序图、ER 图等
- 基于现有项目代码自动生成架构可视化图表
- 团队协作中的 PlantUML 图编辑与预览
- 论文、技术文档中的 PlantUML 插图制作

---

## ✨ 功能特性

### 🎨 PlantUML 编辑与渲染

- 源码编辑器与实时预览双面板布局
- 支持 **SVG** 和 **PNG** 两种输出格式
- 右键预览区即可**复制 PNG 到剪贴板**
- 一键导出渲染结果为文件
- 渲染错误信息清晰展示，便于调试

### 🤖 DeepSeek AI 智能生成

- **纯自然语言制图**：输入如"画一个用户登录的时序图，包含前端、网关、认证服务与数据库"，AI 自动生成 PlantUML 源码
- **自动校验修正**：生成的源码经本地 PlantUML 引擎校验，失败时自动请求 AI 修正（可配置最多 15 轮修正）
- **可配置 API**：支持自定义 Base URL 和模型名，兼容 DeepSeek 官方接口

### 📂 项目目录驱动制图（2.0 Beta）

- 选择本地工程根目录，自动构建项目文件索引
- 尊重 `.gitignore`（简化匹配）并排除常见密钥/凭证路径
- 支持**自定义忽略规则**（glob 模式）
- **规划阶段**：AI 先分析项目结构，智能选取关键文件（入口、路由、领域模型、API 等）
- **源码聚合**：将选中文件正文与制图目标一同发送给 AI
- **上下文估算**：在不调用 AI 的情况下粗算首轮消息 tokens，超过约 100 万 tokens 时中止并提示
- 密钥等敏感信息不会发送到云端

### 🗃️ 产出物暂存区

- 将渲染结果持久保存到本地暂存区
- 支持缩略图预览、查看大图、复制、删除
- 批量选择与删除操作
- 重启应用后条目依然保留
- 自动保存 PlantUML 源码快照

### 📋 日志与错误归档

- **执行日志**：记录每次 AI 生成的完整过程（菜单「文件 → 查看本次执行日志」）
- **错误归档**：自动记录渲染错误、AI 异常等，便于排查问题（菜单「文件 → 查看错误日志」）

---

## 🚀 快速开始

### 环境要求

- **操作系统**：Windows x64（当前安装包目标平台）
- **Node.js**：用于开发运行
- **Java**：PlantUML 渲染需要 JRE（构建脚本可自动下载捆绑 JRE）

### 开发运行

```bash
# 1. 进入项目目录
cd plantuml-desktop

# 2. 安装依赖
npm install

# 3. 下载 JRE（首次或缺少 JRE 时）
npm run prepare:jre

# 4. 下载 PlantUML JAR（首次或 vendor/plantuml 为空时）
npm run prepare:plantuml

# 5. 启动开发模式
npm start
```

> **注意**：`plantuml-*.jar` 默认不在 git 中。开发可执行 `npm run prepare:plantuml` 自动下载到 `vendor/plantuml/`，或手动放入 JAR / 设置环境变量 `PLANTUML_JAR`。

### 生产打包

```bash
# 构建安装包（自动下载 Windows JRE + 官方 PlantUML JAR 并打包）
npm run dist

# 或构建 Beta 版
npm run dist:beta

# 仅构建便携版（免安装）
npm run dist:portable

# 仅构建 NSIS 安装包
npm run dist:nsis
```

打包产物位于 `releases/` 目录，包含：
- NSIS 安装包（`.exe`）
- 便携版（`.exe`，免安装）
- `win-unpacked` 目录（解压即用）

---

## 🎯 使用指南

### 基本使用流程

1. **启动应用**，状态栏显示已连接 PlantUML 服务
2. 在左侧编辑器中编写 PlantUML 源码（默认提供示例）
3. 选择输出格式（SVG/PNG）
4. 点击 **「渲染预览」** 查看结果
5. 右键预览区可复制 PNG 到剪贴板
6. 点击 **「导出文件…」** 可下载渲染结果

### AI 智能生成

1. 点击 **「API 与智能生成」** 展开配置面板
2. 填写 **DeepSeek API Key**（在 [platform.deepseek.com](https://platform.deepseek.com) 获取）
3. （可选）配置 Base URL、模型名、修正轮数
4. 点击 **「保存设置」**
5. 在 **「自然语言需求」** 文本框中描述你要画的图
6. 点击 **「生成 PlantUML 并填入编辑器」**
7. AI 生成的源码会自动填入编辑器并触发预览

### 项目目录制图

1. 确保已配置 DeepSeek API Key
2. 在 **「项目目录驱动制图」** 区域点击 **「选择项目文件夹…」**
3. 选择你的工程根目录
4. 在 **「自然语言需求」** 中描述制图目标（如"画一个订单系统的类图"）
5. （可选）点击 **「估算上下文」** 预估算 tokens 用量
6. 点击 **「一键生成」**，AI 将自动分析项目并生成图表

### 暂存区管理

- 渲染预览后点击 **「加入暂存区」** 保存当前结果
- 在暂存区可查看缩略图、放大预览、复制、删除
- 支持多选批量删除
- 暂存区数据持久化保存

---

## ⚙️ 配置说明

### 配置文件位置

所有配置和数据存储在用户目录：

```
%AppData%\plantuml-studio-local\
```

| 文件/目录 | 说明 |
|-----------|------|
| `studio-agent-config.json` | DeepSeek API 配置、项目路径、忽略规则 |
| `studio-error-archive.jsonl` | 错误日志归档 |
| `output-stash/` | 产出物暂存区（图片 + PlantUML 源码快照） |

### 环境变量

| 变量 | 说明 |
|------|------|
| `PLANTUML_JAR` | 指定 PlantUML JAR 文件路径 |
| `JAVA_HOME` | 指定 Java 运行时路径 |
| `ADOPTIUM_JRE_URL` | 自定义 JRE 下载地址 |
| `SKIP_JRE_DOWNLOAD` | 设为 `1` 跳过 JRE 下载 |

### 项目忽略规则

支持自定义 glob 模式忽略项目目录中的文件（与 `.gitignore` 叠加），例如：

```
**/dist/**
*.min.js
**/generated/**
```

可通过 **Shift+点击** 或 **双击** 紧凑栏的「设置」或齿轮图标打开忽略规则配置弹窗。

---

## 🏗️ 项目架构

```
plantuml-desktop/
├── electron-main.mjs      # Electron 主进程（窗口管理、IPC、PlantUML 服务、AI 编排）
├── preload.cjs            # 预加载脚本（安全暴露 API 到渲染进程）
├── package.json           # 项目配置与构建脚本
├── renderer/
│   ├── index.html         # 主界面 HTML
│   ├── app.js             # 渲染进程逻辑（UI 交互、渲染请求、暂存区管理）
│   └── style.css          # 界面样式
├── scripts/
│   ├── app-menu.mjs       # 应用菜单（中文）
│   ├── download-jre.mjs   # JRE 下载脚本
│   ├── project-index.mjs  # 项目目录索引（扫描、忽略规则、启发式选文件）
│   └── project-context.mjs # 项目上下文聚合（文件读取、上下文预算计算）
├── assets/
│   └── app-logo-512.png   # 应用图标
├── docs/
│   └── M3-smoke-checklist.md  # 冒烟测试清单
└── vendor/jre/            # 捆绑的 JRE（构建时下载）
```

### 核心工作流程

```
用户输入自然语言需求
        │
        ▼
┌─────────────────────────────────┐
│   DeepSeek AI 生成 PlantUML     │
│   （纯文本模式 / 项目模式）      │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│   本地 PlantUML PicoWeb 校验     │
│   （Java + 官方 JAR 渲染）       │
└──────────┬──────────────────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
   通过         失败
     │           │
     │     ┌─────▼────────────┐
     │     │ 自动请求 AI 修正  │
     │     │（最多 N 轮重试）  │
     │     └─────┬────────────┘
     │           │
     ▼           ▼
┌─────────────────────────────────┐
│   渲染结果展示 + 暂存区管理      │
└─────────────────────────────────┘
```

---

## 🧪 冒烟测试

详见 [docs/M3-smoke-checklist.md](docs/M3-smoke-checklist.md)，涵盖：

- 启动与渲染
- 剪贴板与 CSP
- 暂存区功能
- DeepSeek 纯自然语言生成
- 项目目录驱动制图
- 安装包验证

---

## 🛠️ 技术栈

| 技术 | 用途 |
|------|------|
| [Electron](https://www.electronjs.org/) | 桌面应用框架 |
| [PlantUML](https://plantuml.com/) | UML 图渲染引擎（PicoWeb 模式） |
| [DeepSeek API](https://platform.deepseek.com/) | AI 自然语言生成 PlantUML |
| [Eclipse Temurin](https://adoptium.net/) | 捆绑的 JRE（Java 17） |
| [electron-builder](https://www.electron.build/) | 应用打包与分发 |

---

## 📄 许可证

本项目基于 **GPL-3.0** 许可证开源。

分发时请注意：
- **PlantUML** 上游许可证（GPL-3.0 或兼容许可证）
- **Eclipse Temurin** JRE 许可条款（GPL-2.0 with Classpath Exception）

---

## 📚 相关资源

- [PlantUML 官方文档](https://plantuml.com/zh/guide)
- [PlantUML 语言参考指引](../PlantUML语言参考指引.pdf)
- [UML 大师 Agent 开发计划](../UML大师-Agent-开发计划.md)
- [PlantUML Agent 知识库](../PlantUML-Agent-Knowledge-Base.md)
- [Eclipse Temurin 许可说明](https://adoptium.net/docs/faq/)

