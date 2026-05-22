/**
 * 管理员工具内置发行方私钥（PKCS#8 DER 十六进制）。
 *
 * 与 scripts/license-common.mjs 中的 EMBEDDED_ISSUER_PUBLIC_KEY_HEX 成对；
 * 本仓库按学习交流场景直接入库演示密钥。
 *
 * 留空时将回退到磁盘路径（admin-tool/.issuer-private.der 或用户目录）。
 * 可选用 issuer-embedded-keys.local.mjs 覆盖（.gitignore，不提交）。
 */

/** Ed25519 私钥（PKCS#8 DER hex）。与客户端内置发行方公钥匹配。 */
export const EMBEDDED_ISSUER_PRIVATE_PKCS8_HEX =
  '302e020100300506032b6570042204204b05e5b0c80bf06168801499081ef827a99efd0e4286a533d5e0c3cf00ff35cf';
