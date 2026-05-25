/**
 * 出站请求统一携带的「调用方标识」header。
 *
 * AI 网关读取这两个 header 写入 access_log，识别请求来源与版本：
 *   - x-aiweb3-client          固定为 "gate-dex-cli"（access_log 的 client 字段）
 *   - x-aiweb3-client-version  当前 CLI 版本号（access_log 的 client_version 字段）
 *
 * 头名为《AI 网关统一接入》方案 §2.3.1 表格所列，经后端 @hugo-wbe 确认。
 * （方案 §2.2 代码示例曾写作 `x-ai-client`，以确认结果为准。）
 *
 * 这两个 header 不是 gt 前缀的签名头，不参与 web3_v2 appsign 计算，
 * 因此可以安全附加到任何已签名 / 未签名的请求上。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `x-aiweb3-client` header 固定值。 */
export const CLIENT_NAME = "gate-dex-cli";

let _clientVersion: string | null = null;

/**
 * 解析当前 CLI 版本：
 *   1. 打包成二进制时 build-time 注入的 `__BUNDLED_PKG__.version`；
 *   2. 否则读取包根目录的 package.json（tsx 源码运行 / tsc 产物 / 全局安装均适用）；
 *   3. 都拿不到时回落 "dev"。
 * 结果进程内缓存，只解析一次。
 */
export function getClientVersion(): string {
  if (_clientVersion) return _clientVersion;

  const bundled = (globalThis as { __BUNDLED_PKG__?: { version?: string } })
    .__BUNDLED_PKG__?.version;
  if (typeof bundled === "string" && bundled) {
    _clientVersion = bundled;
    return _clientVersion;
  }

  try {
    // 本模块位于 <pkg>/{src,dist}/core/ —— 上溯两级即包根。
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const pkg = JSON.parse(
      readFileSync(join(pkgRoot, "package.json"), "utf-8"),
    ) as { version?: string };
    _clientVersion =
      typeof pkg.version === "string" && pkg.version ? pkg.version : "dev";
  } catch {
    _clientVersion = "dev";
  }
  return _clientVersion;
}

/**
 * 所有出站请求统一附加的 client 标识 header。
 * 用法：`headers: { ...clientHeaders(), ...其它 header }`
 */
export function clientHeaders(): Record<string, string> {
  return {
    "x-aiweb3-client": CLIENT_NAME,
    "x-aiweb3-client-version": getClientVersion(),
  };
}
