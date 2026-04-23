/**
 * 动态 web3_domain 获取
 *
 * 流程（简化自 web3-wallet-plugin-web 的 gt-remote-config.ts，只保留 web3_domain，
 * 不含云备份 / 静态 CDN / 轮询）：
 *   1. 根据 RUN_ENV (dev/pre/prod) 选候选 CDN URL 列表
 *   2. 并行 Ping 候选（GET {host}/v1/cdn/get-dynamic），找出第一个可用的
 *   3. 拉取 { code, data: { web3_domain: [{ host }] } }
 *   4. 对 web3_domain 做并行 speed test（GET {host}/speed_test），按响应时间排序
 *   5. 结果缓存到 ~/.gate-wallet/web3-domain.json，TTL = 5 分钟
 *
 * 使用方式：
 *   const primary = await getPrimaryWeb3Domain();   // 最快的可用域名
 *   const list = await getAvailableWeb3Domains();   // 全部可用域名（已排序）
 *   await refreshWeb3Domains();                      // 强制刷新
 *
 * 拿到的域名形如 "http://test-api.ldd710.com"，拼路径即为最终 URL。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAuthDir } from "./token-store.js";

function getCacheFile(): string {
  return join(getAuthDir(), "web3-domain.json");
}
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TIMEOUT_MS = 5000;

// ── 环境检测 ─────────────────────────────────────────────────

type RunEnv = "dev" | "pre" | "prod";

function getRunEnv(): RunEnv {
  const e = (process.env["RUN_ENV"] ?? "").toLowerCase();
  if (e === "dev" || e === "development") return "dev";
  if (e === "pre" || e === "pre-production") return "pre";
  return "prod";
}

/** CDN 候选域名（get-dynamic 接口），按优先级排序 */
function getCdnCandidateDomains(env: RunEnv): string[] {
  if (env === "dev") return ["web3-wallet-cdn-test.gateweb3.cc"];
  if (env === "pre") return ["web3-wallet-cdn-pre.gateweb3.cc"];
  return [
    "api.freshmarkethome.com/api/plug/v1/web3-wallet-cdn",
    "api.freshmarketpage.com/api/plug/v1/web3-wallet-cdn",
    "api.gateweb3.io/api/plug/v1/web3-wallet-cdn",
    "api.ldd678.com/api/plug/v1/web3-wallet-cdn",
    "api.web3gate.cc/api/plug/v1/web3-wallet-cdn",
    "api.web3gate.io/api/plug/v1/web3-wallet-cdn",
    "web3-wallet-cdn-prod.gateweb3.cc",
  ];
}

// ── 类型定义 ─────────────────────────────────────────────────

export interface Web3DomainItem {
  host: string;
  available?: boolean;
  response_time_ms?: number;
}

interface RemoteConfigResp {
  web3_domain?: Array<{ host: string }>;
}

interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data: T;
}

interface CacheFile {
  timestamp: number;
  domains: Web3DomainItem[];
}

// ── 网络工具 ─────────────────────────────────────────────────

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    if (res.status >= 500) throw new Error(`${url} returned ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function measureRequestMs(url: string, timeoutMs: number): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    if (res.status >= 500) return Infinity;
    return Math.round(performance.now() - start);
  } catch {
    return Infinity;
  } finally {
    clearTimeout(timer);
  }
}

// ── 1. 找可用的 CDN URL ──────────────────────────────────────

async function findAvailableCdnUrl(env: RunEnv): Promise<string | null> {
  const candidates = getCdnCandidateDomains(env);
  // 并发 ping 所有候选，取第一个 <400 的
  const probes = candidates.map(async (domain) => {
    const httpsUrl = `https://${domain}/v1/cdn/get-dynamic`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(httpsUrl, {
        signal: ctrl.signal,
        headers: { "Cache-Control": "no-cache" },
      });
      clearTimeout(timer);
      return res.status < 400 ? httpsUrl : null;
    } catch {
      return null;
    }
  });
  const results = await Promise.all(probes);
  return results.find((u) => u) ?? null;
}

// ── 2. 拉取 web3_domain 列表 ─────────────────────────────────

async function fetchWeb3DomainList(env: RunEnv): Promise<Array<{ host: string }>> {
  // pre 环境硬编码（和 plugin-web 对齐）
  if (env === "pre") {
    return [
      { host: "http://pre-api.ldd710.com" },
      { host: "http://pre-api.ldd711.com" },
      { host: "http://pre-api.ldd712.com" },
    ];
  }
  const url = await findAvailableCdnUrl(env);
  if (!url) throw new Error("no reachable CDN config URL");
  const body = await fetchJson<ApiEnvelope<RemoteConfigResp>>(url, 10000);
  if (body.code !== 0) {
    throw new Error(`CDN config error (code=${body.code}): ${body.message ?? "unknown"}`);
  }
  const list = body.data?.web3_domain ?? [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("CDN returned empty web3_domain");
  }
  return list;
}

// ── 3. speed test 排序 ───────────────────────────────────────

async function speedTestDomains(
  domains: Array<{ host: string }>,
): Promise<Web3DomainItem[]> {
  const results = await Promise.all(
    domains.map(async ({ host }) => {
      const ms = await measureRequestMs(`${host}/speed_test`, DEFAULT_TIMEOUT_MS);
      return {
        host,
        available: ms !== Infinity,
        response_time_ms: ms === Infinity ? undefined : ms,
      };
    }),
  );
  const available = results
    .filter((r) => r.available)
    .sort((a, b) => (a.response_time_ms ?? 0) - (b.response_time_ms ?? 0));
  const unavailable = results.filter((r) => !r.available);
  return [...available, ...unavailable];
}

// ── 本地缓存 ─────────────────────────────────────────────────

function loadCache(): CacheFile | null {
  try {
    const cacheFile = getCacheFile();
    if (!existsSync(cacheFile)) return null;
    const data = JSON.parse(readFileSync(cacheFile, "utf-8")) as CacheFile;
    if (!data.timestamp || !Array.isArray(data.domains)) return null;
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCache(domains: Web3DomainItem[]): void {
  try {
    const cacheFile = getCacheFile();
    mkdirSync(getAuthDir(), { recursive: true });
    const data: CacheFile = { timestamp: Date.now(), domains };
    writeFileSync(cacheFile, JSON.stringify(data, null, 2));
  } catch {
    // 缓存写失败不阻塞
  }
}

// ── 公共 API ────────────────────────────────────────────────

let inflight: Promise<Web3DomainItem[]> | null = null;

/**
 * 获取完整的 web3_domain 列表（已 speed-test 排序，最快在前）。
 * 命中本地缓存（5 分钟内）时立即返回；否则拉远程并更新缓存。
 */
export async function getWeb3Domains(): Promise<Web3DomainItem[]> {
  const cached = loadCache();
  if (cached) return cached.domains;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const env = getRunEnv();
      const raw = await fetchWeb3DomainList(env);
      const tested = await speedTestDomains(raw);
      saveCache(tested);
      return tested;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 强制刷新（忽略缓存）。 */
export async function refreshWeb3Domains(): Promise<Web3DomainItem[]> {
  const env = getRunEnv();
  const raw = await fetchWeb3DomainList(env);
  const tested = await speedTestDomains(raw);
  saveCache(tested);
  return tested;
}

/** 仅获取可用的（available=true）域名，按响应速度排序。 */
export async function getAvailableWeb3Domains(): Promise<string[]> {
  const all = await getWeb3Domains();
  return all.filter((d) => d.available !== false).map((d) => d.host);
}

/** 主域名（最快的可用域名）。没有可用时返回空串。 */
export async function getPrimaryWeb3Domain(): Promise<string> {
  const list = await getAvailableWeb3Domains();
  return list[0] ?? "";
}

/** 调试信息。 */
export async function getWeb3DomainInfo(): Promise<{
  primary: string;
  available: string[];
  all: Web3DomainItem[];
  cache_path: string;
}> {
  const all = await getWeb3Domains();
  const available = all.filter((d) => d.available !== false).map((d) => d.host);
  return {
    primary: available[0] ?? "",
    available,
    all,
    cache_path: getCacheFile(),
  };
}
