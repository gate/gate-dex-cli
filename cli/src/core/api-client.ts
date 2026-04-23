/**
 * Gate Wallet REST API Client
 * 直接调用业务接口，替代 MCP tool 调用
 *
 * wallet service (gateio-service-web3-wallet):
 *   test: https://web3-wallet-service-test.gateweb3.cc
 *   pre:  https://web3-wallet-service-pre.gateweb3.cc
 *   prod: https://web3-wallet-service-prod.gateweb3.cc
 *
 * bw service (web3-business-wallet):
 *   test: https://web3-business-wallet-test.gateweb3.cc  (待确认)
 *   pre:  https://web3-business-wallet-pre.gateweb3.cc   (待确认)
 *   prod: https://web3-business-wallet-prod.gateweb3.cc  (待确认)
 *
 * market token service (gateio_service_web3_trade_token):
 *   test: https://apipro-test-new.gateweb3.cc
 *   pre:  https://apipro-pre-new.gateweb3.cc   (待确认)
 *   prod: https://apipro-new.gateweb3.cc        (待确认)
 */

import { getOrCreateDeviceToken } from "./token-store.js";

function bwDeviceToken(): string {
  return getOrCreateDeviceToken();
}

// ─── URL 配置 ──────────────────────────────────────────────

const DEFAULT_WALLET_SERVICE_URL = "https://web3-wallet-service-test.gateweb3.cc";
const DEFAULT_BW_SERVICE_URL = "https://web3-business-wallet-test.gateweb3.cc";
const DEFAULT_MARKET_TOKEN_URL = "https://apipro-test-new.gateweb3.cc";

export function getWalletServiceUrl(): string {
  return process.env["WALLET_SERVICE_URL"] ?? DEFAULT_WALLET_SERVICE_URL;
}

export function getBwServiceUrl(): string {
  return process.env["BW_SERVICE_URL"] ?? DEFAULT_BW_SERVICE_URL;
}

/**
 * web3-business-wallet 网关 base URL（登录接口用）。
 *   test: https://webapi-test.gateweb3.cc/api/web/v1/web3-business-wallet
 *   pre/prod: https://webapi.gateweb3.cc/api/web/v1/web3-business-wallet
 *
 * 登录的完整路径：`{BIZ_WALLET_URL}/v1/wallet/oauth/{gate|google}/device/{start|poll}`
 */
export function getBizWalletUrl(): string {
  return (
    process.env["BIZ_WALLET_URL"] ??
    "https://webapi-test.gateweb3.cc/api/web/v1/web3-business-wallet"
  );
}

interface MerchantCredentials {
  appKey: string;
  appSecret: string;
}

let _merchantCreds: MerchantCredentials | null = null;

/**
 * GET /v1/wallet/config/merchant — 动态拉取 mcp_wallet_yikFT6 对应的 appKey + appSecret。
 * 结果进程内缓存，只拉一次。
 */
export async function fetchMerchantCredentials(): Promise<MerchantCredentials> {
  if (_merchantCreds) return _merchantCreds;
  if (process.env["BW_APP_KEY"] && process.env["BW_APP_SECRET"]) {
    _merchantCreds = {
      appKey: process.env["BW_APP_KEY"],
      appSecret: process.env["BW_APP_SECRET"],
    };
    return _merchantCreds;
  }
  const url = `${getBizWalletUrl()}/v1/wallet/config/merchant`;
  const res = await fetch(url, {
    headers: { "x-gtweb3-app-id": getBwAppId() },
  });
  const json = (await res.json()) as {
    code: number;
    data?: { app_id: string; sign_secret: string };
  };
  if (json.code !== 0 || !json.data) {
    throw new Error(`获取 merchant credentials 失败 (code=${json.code})`);
  }
  _merchantCreds = { appKey: json.data.app_id, appSecret: json.data.sign_secret };
  return _merchantCreds;
}

/**
 * `x-gtweb3-app-id` — BW/fomox 业务侧的 app 标识（不参与签名）。
 * 和 `APP_KEY` 是两个不同的值：
 *   - APP_KEY ("key7"/"4bda..." 等)：用于 MD5 签名计算
 *   - APP_ID ("mcp_wallet_yikFT6")：business-wallet / fomox 识别调用方
 */
export function getBwAppId(): string {
  return process.env["BW_APP_ID"] ?? "mcp_wallet_yikFT6";
}

export function getMarketTokenUrl(): string {
  return process.env["MARKET_TOKEN_URL"] ?? DEFAULT_MARKET_TOKEN_URL;
}

// ─── 公共类型 ──────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  code: number;
  message?: string;
  data: T;
}

// ─── Wallet Service 类型 ───────────────────────────────────

export interface WalletAddress {
  chainType: string;
  walletAddress: string[];
  walletAddressFormat: Array<Record<string, string>>;
}

export interface GetAddressesResult {
  account_id: string;
  addresses: Record<string, string>;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  network_key: string;
  address: string;
  balance: string;
  price: string;
  value: string;
}

export interface GetTokenListResult {
  account_id: string;
  account_total_amount: string;
  tokens: TokenInfo[];
  continue: boolean;
  page: number;
  page_size: number;
  page_count: number;
  total_count: number;
}

export interface GetTotalAssetResult {
  account_id: string;
  total_value: string;
  origin_total_value: string;
  change_value: string;
  change_percent: string;
  change_type: number;
}

// ─── BW Service 类型 ───────────────────────────────────────

export interface SignMessageResult {
  signature: string;
  publicKey: string;
}

export interface SignTransactionResult {
  signature: string;
  publicKey: string;
  signedTransaction: string;
  signedTransactionWith0x?: string;
}

// ─── 公共请求方法 ──────────────────────────────────────────

async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T> {
  const allHeaders = { "Content-Type": "application/json", ...headers };
  const bodyStr = JSON.stringify(body);
  if (process.env["DEBUG_API"]) {
    console.log(`\n[DEBUG] POST ${url}`);
    console.log(`[DEBUG] Headers:`, JSON.stringify(allHeaders, null, 2));
    console.log(`[DEBUG] Body:`, bodyStr);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: allHeaders,
    body: bodyStr,
  });
  const text = await res.text();
  if (process.env["DEBUG_API"]) {
    console.log(`[DEBUG] Status: ${res.status}`);
    console.log(`[DEBUG] Response:`, text);
  }
  let json: ApiResponse<T>;
  try {
    json = JSON.parse(text) as ApiResponse<T>;
  } catch {
    throw new Error(`API 响应非 JSON [${new URL(url).pathname}]: ${text.slice(0, 200)}`);
  }
  const path = new URL(url).pathname;
  if (json.code !== 0) {
    throw new Error(
      `API 请求失败 [${path}] (code=${json.code}): ${json.message ?? "unknown error"}`,
    );
  }
  return json.data;
}

// ─── WalletApiClient ──────────────────────────────────────

export class WalletApiClient {
  private readonly baseUrl: string;
  private readonly mcpToken: string;

  constructor(opts: { baseUrl: string; mcpToken: string }) {
    this.baseUrl = opts.baseUrl;
    this.mcpToken = opts.mcpToken;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.mcpToken}` };
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return postJson<T>(`${this.baseUrl}${path}`, this.headers(), body);
  }

  /**
   * 查询钱包地址
   * POST /wallet/inner/get-addressed-by-accountid
   */
  async getAddresses(accountId: string): Promise<GetAddressesResult> {
    const raw = await this.post<Record<string, WalletAddress[]>>(
      "/wallet/inner/get-addressed-by-accountid",
      { accountId: [accountId] },
    );

    const resolvedId = Object.keys(raw)[0] ?? accountId;
    const items = raw[resolvedId] ?? [];

    const addresses: Record<string, string> = {};
    for (const item of items) {
      const chainType = item.chainType?.trim();
      const addr = item.walletAddress?.[0]?.trim();
      if (chainType && addr) {
        addresses[chainType] = addr;
      }
    }

    return { account_id: resolvedId, addresses };
  }

  /**
   * 查询 Token 列表和余额
   * POST /wallet/inner/token-list
   */
  async getTokenList(
    accountId: string,
    opts: { networkKeys?: string[]; page?: number; pageSize?: number } = {},
  ): Promise<GetTokenListResult> {
    const body: Record<string, unknown> = { accountId };
    if (opts.networkKeys?.length) body.networkKeyList = opts.networkKeys;
    if (opts.page) body.page = opts.page;
    if (opts.pageSize) body.pageSize = opts.pageSize;

    const raw = await this.post<{
      accountID: string;
      accountTotalAmount: string;
      coinArrValidate: Array<{
        symbol: string;
        name: string;
        networkKey: string;
        address: string;
        balance: string;
        price: string;
        value: string;
      }>;
      continue: boolean;
      page: number;
      pageSize: number;
      pageCount: number;
      totalCount: number;
    }>("/wallet/inner/token-list", body);

    return {
      account_id: raw.accountID,
      account_total_amount: raw.accountTotalAmount,
      tokens: (raw.coinArrValidate ?? []).map((t) => ({
        symbol: t.symbol,
        name: t.name,
        network_key: t.networkKey,
        address: t.address,
        balance: t.balance,
        price: t.price,
        value: t.value,
      })),
      continue: raw.continue,
      page: raw.page,
      page_size: raw.pageSize,
      page_count: raw.pageCount,
      total_count: raw.totalCount,
    };
  }

  /**
   * 查询总资产
   * POST /wallet/inner/asset/total-asset
   */
  async getTotalAsset(accountId: string): Promise<GetTotalAssetResult> {
    const raw = await this.post<{
      accountID: string;
      accountTotalAmount: string;
      originAccountTotalAmount: string;
      priceFluctuation: {
        fluctuationTotal: string;
        fluctuationPercentage: string;
        fluctuationType: number;
      };
    }>("/wallet/inner/asset/total-asset", { accountId });

    return {
      account_id: raw.accountID,
      total_value: raw.accountTotalAmount,
      origin_total_value: raw.originAccountTotalAmount,
      change_value: raw.priceFluctuation.fluctuationTotal,
      change_percent: raw.priceFluctuation.fluctuationPercentage,
      change_type: raw.priceFluctuation.fluctuationType,
    };
  }
}

// ─── BwApiClient ──────────────────────────────────────────

import { createHash } from "node:crypto";

function md5Hex(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

/**
 * Compute `x-gtweb3-appsign` (web3_v2) — mirrors plugin-web's getAppSign.
 *
 *   sign = md5(APP_KEY + METHOD + path + searchParamsStr + paramsStr + headerStr + APP_SECRET)
 *
 *   searchParamsStr: sorted query, "keyvalue" joined (key lowercased)
 *   paramsStr: JSON.stringify(body) for POST, else ""
 *   headerStr: sorted (by lowercased key) gt-prefixed headers, "keyvalue" joined
 */
function computeAppSign(
  appKey: string,
  appSecret: string,
  method: string,
  url: string,
  body: unknown,
  signHeaders: Record<string, string>,
): string {
  const u = new URL(url);
  const path = u.pathname;

  // Query string (sorted, lowercase keys)
  let searchParamsStr = "";
  if (u.search.length > 1) {
    const entries: Array<[string, string]> = [];
    u.searchParams.forEach((v, k) => entries.push([k, v]));
    entries.sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
    searchParamsStr = entries
      .map(([k, v]) => `${k.toLowerCase()}${v}`)
      .join("");
  }

  // Body
  const paramsStr =
    method.toUpperCase() === "POST" && body != null ? JSON.stringify(body) : "";

  // Header string — keys sorted (lowercased), "keyvalue" joined
  const headerKeys = Object.keys(signHeaders)
    .slice()
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const headerStr = headerKeys
    .map((k) => `${k.toLowerCase()}${signHeaders[k]}`)
    .join("");

  const raw =
    appKey + method.toUpperCase() + path + searchParamsStr + paramsStr + headerStr + appSecret;
  return md5Hex(raw);
}

export class BwApiClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly appId: string;
  private readonly deviceToken: string;
  private readonly version: string;

  constructor(opts: {
    baseUrl: string;
    accessToken: string;
    appKey: string;
    appSecret: string;
    appId: string;
    deviceToken: string;
    version?: string;
  }) {
    this.baseUrl = opts.baseUrl;
    this.accessToken = opts.accessToken;
    this.appKey = opts.appKey;
    this.appSecret = opts.appSecret;
    this.appId = opts.appId;
    this.deviceToken = opts.deviceToken;
    this.version = opts.version ?? "1.0.0";
  }

  /**
   * Build the gt-prefixed headers that participate in signing.
   * Matches plugin-web (apps/background/utils/gt-fetch/index.ts getRequestHeader) exactly.
   */
  private buildSignHeaders(): Record<string, string> {
    const time = String(Date.now());
    return {
      "x-gtweb3-appKey": this.appKey,
      "x-gtweb3-random": md5Hex(`${this.deviceToken}${time}`).slice(0, 10),
      "x-gtweb3-time": time,
      "x-gtweb3-applang": "en",
      "x-gtweb3-device-type": "5",
      "x-gtweb3-device-id": this.deviceToken,
      "x-gtweb3-night": "0",
      "x-gtweb3-sign-version": "web3_v2",
      "x-gtweb3-version": this.version,
      "x-gtweb3-device-token": this.deviceToken,
    };
  }

  private allHeaders(method: string, url: string, body: unknown): Record<string, string> {
    const signHeaders = this.buildSignHeaders();
    const appsign = computeAppSign(
      this.appKey,
      this.appSecret,
      method,
      url,
      body,
      signHeaders,
    );
    return {
      ...signHeaders,
      "x-gtweb3-appsign": appsign,
      "x-gtweb3-app-id": this.appId,
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return postJson<T>(url, this.allHeaders("POST", url, body), body);
  }

  /**
   * 签名消息
   * POST /v1/wallet/quick/sign-message
   */
  async signMessage(opts: {
    message: string;
    chain: string;
    checkinToken: string;
  }): Promise<SignMessageResult> {
    const chain = normalizeChain(opts.chain);
    return this.post<SignMessageResult>("/v1/wallet/quick/sign-message", {
      access_token: this.accessToken,
      message: opts.message,
      chain,
      checkin_token: opts.checkinToken,
    });
  }

  /**
   * 签名交易
   * POST /v1/wallet/quick/sign-transaction
   */
  async signTransaction(opts: {
    rawTx: string;
    chain: string;
    checkinToken: string;
  }): Promise<SignTransactionResult> {
    const chain = normalizeChain(opts.chain);
    const path = "/v1/wallet/quick/sign-transaction";
    const url = `${this.baseUrl}${path}`;
    const body = {
      rawUnsignedTransaction: opts.rawTx,
      access_token: this.accessToken,
      chain,
      checkin_token: opts.checkinToken,
    };
    const headers = this.allHeaders("POST", url, body);
    return postJson<SignTransactionResult>(url, headers, body);
  }

  /** POST /v1/wallet/quick/logout */
  async logout(): Promise<void> {
    const url = `${this.baseUrl}/v1/wallet/quick/logout`;
    const body = { access_token: this.accessToken };
    const headers = this.allHeaders("POST", url, body);
    await postJson<unknown>(url, headers, body).catch(() => {/* ignore server errors */});
  }
}

// ─── MarketApiClient 类型 ──────────────────────────────────

export interface SwapBridgeToken {
  chain_id: number;
  chain_name: string;
  web3_key: string;
  chain: string;
  address: string;
  name: string;
  symbol: string;
  decimal: number;
  icon: string;
  is_favorite: boolean;
  native_coin: boolean;
  community_certified: boolean;
  raw_tags: string[];
  current_price: unknown;
  token_balance: string;
  token_balance_usd: string;
  security_info: {
    is_open_source: boolean | null;
    is_pixiu: number;
    buy_tax: string;
    sell_tax: string;
  };
}

export interface ListSwapBridgeTokensResult {
  tokens: SwapBridgeToken[];
  favorites: number;
}

// ─── MarketApiClient ──────────────────────────────────────

export class MarketApiClient {
  private readonly baseUrl: string;

  constructor(opts: { baseUrl: string }) {
    this.baseUrl = opts.baseUrl;
  }

  /**
   * 查询可兑换/跨链桥 Token 列表
   * GET /web3api/v2/token/swap_bridge_list
   */
  async listSwapBridgeTokens(opts: {
    chain?: string;
    tag?: string;
    wallet?: string;
    accountId?: string;
    search?: string;
    searchAuth?: boolean;
    ignoreBridge?: boolean;
    web3Key?: string;
    sourceChain?: string;
    sourceAddress?: string;
  } = {}): Promise<ListSwapBridgeTokensResult> {
    const params = new URLSearchParams();
    if (opts.chain) params.set("chain", opts.chain);
    if (opts.tag) params.set("tag", opts.tag);
    if (opts.wallet) params.set("wallet", opts.wallet);
    if (opts.accountId) params.set("account_id", opts.accountId);
    if (opts.search) params.set("search", opts.search);
    if (opts.searchAuth != null) params.set("search_auth", String(opts.searchAuth));
    if (opts.ignoreBridge) params.set("ignore_bridge", "true");
    if (opts.web3Key) params.set("web3_key", opts.web3Key);
    if (opts.sourceChain) params.set("source_chain", opts.sourceChain);
    if (opts.sourceAddress) params.set("source_address", opts.sourceAddress);

    const url = `${this.baseUrl}/web3api/v2/token/swap_bridge_list?${params.toString()}`;
    const res = await fetch(url, {
      headers: { "X-Gtweb3-Device-Type": "3" },
    });
    const json = (await res.json()) as { code: number; message?: string; data: ListSwapBridgeTokensResult };
    if (json.code !== 0) {
      throw new Error(`API 请求失败 [/web3api/v2/token/swap_bridge_list] (code=${json.code}): ${json.message ?? "unknown error"}`);
    }
    return json.data;
  }
}

// ─── DataApiClient 类型 ───────────────────────────────────

export interface TokenQueryReq {
  address?: { eq?: string };
  chain?: { in: string[] };
  created_at?: { range?: { start: string; end: string } };
  limit?: number;
  sort?: Array<{ field: string; order: "asc" | "desc" }>;
}

export interface TokenQueryItem {
  chain: string;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  liquidity: number;
  holder_count: number;
  pair_address: string;
  trend_info: {
    price_change_1h: number;
    price_change_4h: number;
    price_change_24h: number;
    price_high_24h: number;
    price_low_24h: number;
    volume_1h: number;
    volume_4h: number;
    volume_24h: number;
    tx_count_24h: number;
    trader_count_24h: number;
  };
  risk_info: {
    high_risk_num: number;
    middle_risk_num: number;
    low_risk_num: number;
  };
  created_at: string;
  token_icon: string;
}

export interface TokenQueryResult {
  tokens: TokenQueryItem[];
  next_cursor: string;
}

// ─── DataApiClient ────────────────────────────────────────

export class DataApiClient {
  private readonly baseUrl: string;

  constructor(opts: { baseUrl: string }) {
    this.baseUrl = opts.baseUrl;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { code: number; message?: string; data: T };
    if (json.code !== 0) {
      throw new Error(`API 请求失败 [${path}] (code=${json.code}): ${json.message ?? "unknown error"}`);
    }
    return json.data;
  }

  /** 查询 Token 详情（通用）POST /v1/base/token/query */
  async tokenQuery(req: TokenQueryReq): Promise<TokenQueryResult> {
    const data = await this.post<{ list: TokenQueryItem[]; next_cursor?: string }>(
      "/v1/base/token/query",
      req,
    );
    return { tokens: data.list ?? [], next_cursor: data.next_cursor ?? "" };
  }

  /** 查询安全审计信息 POST /v1/base/token_security/risk_infos */
  async getSecurityRiskInfos(chain: string, address: string, opts: { lan?: string; ignore?: boolean } = {}): Promise<unknown> {
    const data = await this.post<{ tokens: unknown[] }>(
      "/v1/base/token_security/risk_infos",
      {
        base_symbols: [],
        token_addresses: [{ chain, address }],
        lan: opts.lan ?? "",
        ignore: opts.ignore ?? false,
      },
    );
    return data.tokens?.[0] ?? { chain, address, message: "no security data found" };
  }
}

// ─── MarketTradeClient 类型 ───────────────────────────────

export interface KlineItem {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

// ─── MarketTradeClient ────────────────────────────────────

const PERIOD_MAP: Record<string, number> = {
  "1m": 60, "5m": 300, "1h": 3600, "4h": 14400, "1d": 86400,
};

export class MarketTradeClient {
  private readonly baseUrl: string;

  constructor(opts: { baseUrl: string }) {
    this.baseUrl = opts.baseUrl;
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== "") q.set(k, String(v));
    }
    const url = `${this.baseUrl}${path}?${q.toString()}`;
    const res = await fetch(url);
    const json = (await res.json()) as { code: number; message?: string; data: T };
    if (json.code !== 0) {
      throw new Error(`API 请求失败 [${path}] (code=${json.code}): ${json.message ?? "unknown error"}`);
    }
    return json.data;
  }

  /** K 线数据 GET /web3api/v2/trade/kline */
  async getKline(opts: {
    chain: string;
    tokenAddress: string;
    period: string | number;
    startTime?: number;
    endTime?: number;
    limit?: number;
    pairAddress?: string;
  }): Promise<KlineItem[]> {
    const periodSec = typeof opts.period === "number"
      ? opts.period
      : (PERIOD_MAP[opts.period] ?? parseInt(String(opts.period)));
    const endTime = opts.endTime ?? Math.floor(Date.now() / 1000);
    const startTime = opts.startTime ?? endTime - 100 * periodSec;
    return this.get<KlineItem[]>("/web3api/v2/trade/kline", {
      chain: opts.chain,
      token_address: opts.tokenAddress,
      period: periodSec,
      start_time: startTime,
      end_time: endTime,
      limit: opts.limit ?? 100,
      pair_address: opts.pairAddress,
    });
  }

  /** 交易量统计 GET /web3api/v2/trade/volume_stats */
  async getVolumeStats(opts: {
    chain: string;
    tokenAddress: string;
    pairAddress?: string;
  }): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>("/web3api/v2/trade/volume_stats", {
      chain: opts.chain,
      token_address: opts.tokenAddress,
      pair_address: opts.pairAddress,
    });
  }

  /** 流动性池事件 GET /web3api/v2/trade/pair/liquidity/list_v2 */
  async getPairLiquidity(opts: {
    chain: string;
    tokenAddress: string;
    pairAddress?: string;
    pageIndex?: number;
    pageSize?: number;
  }): Promise<unknown> {
    return this.get<unknown>("/web3api/v2/trade/pair/liquidity/list_v2", {
      chain: opts.chain,
      token_address: opts.tokenAddress,
      pair_address: opts.pairAddress,
      page_index: opts.pageIndex ?? 1,
      page_size: Math.min(opts.pageSize ?? 15, 15),
    });
  }
}

// ─── SwapApiClient 类型 ────────────────────────────────────

/** Mirrors wallet_service_mcp model.BuildV3Resp. */
export interface BuildV3Resp {
  unsignedTx?: unknown;          // raw JSON object (UnsignedTxFields)
  unsignedTxString?: string;
  extraData?: string;            // JSON string with srcChainId/from
  ts?: number;
  projectId?: number;
  signature?: string;
  contractAddress?: string;
}

// ─── SwapApiClient ───────────────────────────────────────
// Swap 交易相关：quote / build / submit / detail / history
// base URL: apipro-test-new.gateweb3.cc (MARKET_TOKEN_URL)
// 公网路径: /web3api/v3/transaction/... (不带 internal)

export class SwapApiClient {
  private readonly baseUrl: string;
  private readonly tradeSource: string;

  constructor(opts: { baseUrl: string; tradeSource?: string }) {
    this.baseUrl = opts.baseUrl;
    this.tradeSource = opts.tradeSource ?? "trade-ai";
  }

  private headers(): Record<string, string> {
    return { "x-gtweb3-trade-source": this.tradeSource };
  }

  /** 获取兑换报价 POST /web3api/v3/transaction/quote */
  async quote(req: {
    chain_id_in: number;
    chain_id_out: number;
    token_in: string;
    token_out: string;
    amount: string;
    slippage: number;
    slippage_type?: number;
    swap_type?: number;
    native_in?: number;
    native_out?: number;
    user_wallet?: string;
    from_wallet?: string;
    to_wallet?: string;
    extra_data?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const body = { slippage_type: 1, swap_type: 1, ...req };
    const url = `${this.baseUrl}/web3api/v3/transaction/quote`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await resp.json()) as { code: number; message?: string; msg?: string; data: Record<string, unknown> };
    if (json.code !== 0) {
      throw new Error(`quote error (${json.code}): ${json.message ?? json.msg ?? "unknown"}`);
    }
    return json.data;
  }

  /**
   * 构建 Swap 未签名交易 POST /web3api/v3/transaction/build
   * 入参的 `params.routes` 直接透传 quote 返回的整个 JSON 对象。
   */
  async build(req: {
    projectId: number;
    params: {
      from: string;
      to: string;
      routes: Record<string, unknown>;
    };
    extraData?: Record<string, unknown>;
    userAgent?: string;
    source?: string;
  }): Promise<BuildV3Resp> {
    const url = `${this.baseUrl}/web3api/v3/transaction/build`;
    const body = {
      projectId: req.projectId,
      params: req.params,
      extraData: req.extraData ?? {},
      userAgent: req.userAgent ?? "gate-wallet-cli",
      source: req.source ?? "cli",
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await resp.json()) as {
      status?: number;
      code?: number;
      message?: string;
      msg?: string;
      data: BuildV3Resp;
    };
    const ok = json.status === 200 || json.code === 0;
    if (!ok) {
      throw new Error(
        `build error (status=${json.status ?? json.code}): ${json.message ?? json.msg ?? "unknown"}`,
      );
    }
    return json.data;
  }

  /** 提交兑换 POST /web3api/v3/transaction/submit */
  async submit(req: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}/web3api/v3/transaction/submit`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    const json = (await resp.json()) as { code: number; message?: string; data: unknown; status?: number };
    if (json.code !== 200 && json.code !== 0) {
      throw new Error(`submit error (${json.code}): ${json.message ?? "unknown"}`);
    }
    return json.data;
  }

  /** 查询兑换详情 POST /web3api/v3/transaction/history/swap/detail */
  async swapDetail(txOrderId: string): Promise<unknown> {
    const url = `${this.baseUrl}/web3api/v3/transaction/history/swap/detail`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ tx_order_id: txOrderId }),
    });
    const json = (await resp.json()) as { code: number; message?: string; data: unknown };
    if (json.code !== 0) {
      throw new Error(`swap detail error (${json.code}): ${json.message ?? "unknown"}`);
    }
    return json.data;
  }

  /** 查询兑换历史 GET /web3api/v3/transaction/history */
  async swapHistory(opts: {
    accountId: string;
    pageNum?: number;
    pageSize?: number;
    startTime?: string;
    endTime?: string;
    srcChain?: number;
    dstChain?: number;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    params.set("accountId", opts.accountId);
    if (opts.pageNum) params.set("pageNum", String(opts.pageNum));
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
    if (opts.startTime) params.set("startTime", opts.startTime);
    if (opts.endTime) params.set("endTime", opts.endTime);
    if (opts.srcChain) params.set("srcChain", String(opts.srcChain));
    if (opts.dstChain) params.set("dstChain", String(opts.dstChain));
    const url = `${this.baseUrl}/web3api/v3/transaction/history?${params.toString()}`;
    const resp = await fetch(url, { headers: this.headers() });
    const json = (await resp.json()) as { code: number; message?: string; data: unknown; status?: number };
    if (json.code !== 0 && json.status !== 200) {
      throw new Error(`swap history error (${json.code}): ${json.message ?? "unknown"}`);
    }
    return json.data;
  }
}

// ─── 工具函数 ──────────────────────────────────────────────

/** EVM/SOL 链名标准化（与 MCP server 保持一致） */
function normalizeChain(chain: string): string {
  const upper = chain.toUpperCase();
  if (upper === "SOL" || upper === "SOLANA") return "SOL";
  return "EVM";
}

// ─── 工厂函数 ──────────────────────────────────────────────

export function createWalletApiClient(mcpToken: string): WalletApiClient {
  return new WalletApiClient({ baseUrl: getWalletServiceUrl(), mcpToken });
}

export async function createBwApiClient(accessToken: string): Promise<BwApiClient> {
  const creds = await fetchMerchantCredentials();
  return new BwApiClient({
    baseUrl: getBwServiceUrl(),
    accessToken,
    appKey: creds.appKey,
    appSecret: creds.appSecret,
    appId: getBwAppId(),
    deviceToken: bwDeviceToken(),
  });
}

export function createMarketApiClient(): MarketApiClient {
  return new MarketApiClient({ baseUrl: getMarketTokenUrl() });
}

export function getDataApiUrl(): string {
  return process.env["DATA_API_URL"] ?? "https://web3-data-api-test.gateweb3.cc";
}

export function createDataApiClient(): DataApiClient {
  return new DataApiClient({ baseUrl: getDataApiUrl() });
}

export function createMarketTradeClient(): MarketTradeClient {
  return new MarketTradeClient({ baseUrl: getMarketTokenUrl() });
}

export function createSwapApiClient(): SwapApiClient {
  return new SwapApiClient({ baseUrl: getMarketTokenUrl() });
}
