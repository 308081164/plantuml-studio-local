# PlantUML 密钥生成器（独立 Windows GUI）

## 给最终用户（发行包）

请从仓库 **GitHub Releases** 下载名称类似 **`PlantUML密钥生成器-x.x.x-portable.exe`** 的文件（与主客户端同一 Release）。

在任意 **64 位 Windows 10/11** 电脑上：

- **不需要**另行安装 Java、Python、Node.js；
- **不需要**安装 Electron 或任何运行时（Node 与 Chromium 已随 Electron 便携包打进该 exe）。

双击运行即可。**管理员私钥**仅保存在当前电脑（参见工具内提示），请勿把私钥或完整目录上传到不可信位置。

便携版会向用户临时目录解压程序文件（常见行为）。若企业杀软拦截，请在安全策略中为该 exe 放行，或联系运维白名单。

### 关于 `.asar`

**用户不需要安装或使用任何名为 asar 的工具或运行时。**以前某些 Electron 应用会把脚本打进 `app.asar`（只是内部打包格式）。

本密钥生成器已配置 **`asar: false`**：解压后的应用位于普通目录（如 `resources/app/`），**不会出现依赖本机 `.asar 文件`** 的形态；仍可一键运行，且不改变「无需 Java/Python」的前提。

## 给开发者

- 源码逻辑与客户端共享：**以仓库根目录 `scripts/license-common.mjs` 为唯一可信实现**。
- 本目录下的 **`license-common.mjs`** 为其**打包用副本**。修改授权算法或公钥相关逻辑后，务必在仓库根执行：

```bash
npm run sync:keygen-license
```

- 再打密钥生成器：`cd admin-tool-gui && npm ci && npm run dist`（或由 CI Release 流水线构建）。
