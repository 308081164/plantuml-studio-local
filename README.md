# PlantUML 本地工作室（Electron）

本地 **Java + 官方 PlantUML JAR（PicoWeb）** 渲染，可选 **DeepSeek** 生成 PlantUML 源码并走「生成 → 本地校验 → 自动修正」闭环。**2.0.0+** 系列为 **M3 / 开发计划第 11 节 Beta**：支持选择**项目目录**、本机索引（`.gitignore` 简化匹配 + 自定义 glob + 常见密钥路径排除）、**规划阶段选文件**后聚合源码正文，再结合自然语言一键制图；可「估算上下文」粗算 tokens（超过约 100 万则中止并提示，不自动压缩）。

## 环境要求

- Windows x64（当前安装包目标平台）
- 构建或开发前：仓库内 `../plantuml-master/build/libs/plantuml-*.jar` 可被 `electron-builder` 打进 `extraResources`，或设置 `PLANTUML_JAR`
- `npm run prepare:jre` 下载捆绑 JRE 到 `vendor/jre`（打包脚本会执行）

## 开发运行

```bash
cd plantuml-desktop
npm install
npm run prepare:jre   # 首次或缺少 JRE 时
npm start
```

## 生产打包

```bash
npm run dist
# 或
npm run dist:beta
```

产物目录：`release/`（NSIS 安装包 + 便携 exe + `win-unpacked`）。

## 配置与数据位置

- DeepSeek 与编排参数：`%AppData%\plantuml-studio-local\studio-agent-config.json`（含可选 `lastProjectRoot`、`projectIgnoreGlobs` 多行文本）
- 错误日志归档（菜单「文件 → 查看错误日志」）：`%AppData%\plantuml-studio-local\studio-error-archive.jsonl`
- 产出物暂存：`%AppData%\plantuml-studio-local\output-stash\`

## 冒烟与回归

见 `docs/M3-smoke-checklist.md`。

## 许可证

见 `package.json`（GPL-3.0）；分发时请注意 PlantUML 上游许可证与 JRE 条款。
