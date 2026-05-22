/**
 * 管理员工具内置发行方私钥（PKCS#8 DER 十六进制）。
 *
 * 留空时表示不使用内置私钥，仍从文件路径读取（admin-tool/.issuer-private.der
 * 或用户目录 ~/.uml-master-admin/ed25519-private.der）。
 *
 * 若在公开仓库中提交真实私钥，任何获得源码或解压后应用目录的人均可能伪造激活码；
 * 仅应在内部分发版本中填写，或通过未跟踪的 issuer-embedded-keys.local.mjs 覆盖。
 */

/** Ed25519 私钥（PKCS#8 DER hex）。默认留空 — 请在本机填入或改用 .local 覆盖文件。 */
export const EMBEDDED_ISSUER_PRIVATE_PKCS8_HEX = '';
