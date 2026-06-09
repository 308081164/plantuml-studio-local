# 安装包内置字体（OFL）

构建前执行 `npm run prepare:fonts` 下载：

- **Noto Sans SC**（思源黑体，UI 名「思源黑体（安装包内置）」）
- **Noto Serif SC**（思源宋体，UI 名「思源宋体（安装包内置）」）

许可见同目录 `OFL-*.txt`。字体通过 `extraResources/fonts` 打入安装包，启动时注册到捆绑 JRE 供 PlantUML 渲染使用。
