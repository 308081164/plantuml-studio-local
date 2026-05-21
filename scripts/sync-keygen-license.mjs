#!/usr/bin/env node
/**
 * 将 scripts/license-common.mjs 同步到 admin-tool-gui/license-common.mjs，
 * 使密钥生成器打包目录自包含（不依赖从 ../scripts 再复制）。
 */
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir);
const src = join(root, 'scripts', 'license-common.mjs');
const dest = join(root, 'admin-tool-gui', 'license-common.mjs');
copyFileSync(src, dest);
// eslint-disable-next-line no-console
console.log('[sync:keygen-license] synced → admin-tool-gui/license-common.mjs');
