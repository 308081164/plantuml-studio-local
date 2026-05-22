/**
 * 复制为本目录下的 issuer-embedded-keys.local.mjs（该文件已在 .gitignore 中）
 * 并填入 PKCS#8 DER 十六进制私钥，与本工具打包的 scripts/license-common.mjs
 * 中公钥 EMBEDDED_ISSUER_PUBLIC_KEY_HEX 成对。
 *
 * npm start / 打包构建时会自动合并：.local 中的非空值覆盖 issuer-embedded-keys.mjs。
 */

export const EMBEDDED_ISSUER_PRIVATE_PKCS8_HEX = '';
