/**
 * Gateway API Client — 通过 plugin-web 网关路径 + 动态 web3_domain + web3_v2 签名
 * 调用钱包/交易/链配置等业务接口。
 *
 * URL 组装：
 *   {primary_web3_domain}{GATEWAY_PREFIX}{route}
 *
 * 签名时 path 会剥掉 GATEWAY_PREFIX，与 plugin-web 的 `API_PATH_PREFIX_LIST` 行为一致。
 *
 * 鉴权：
 *   - 每个请求都带 web3_v2 签名（`x-gtweb3-appsign` + 同组 gt-header）
 *   - `Authorization: Bearer <mcp_token | upstream access_token>` 透传给后端
 *
 * 用法：
 *   const gw = createGatewayApiClient(auth.mcp_token);
 *   const data = await gw.post<TokenListResp>("/wallet/token-list", body);
 */

import { createHash } from "node:crypto";
import { getPrimaryWeb3Domain, refreshWeb3Domains } from "./remote-config.js";
import { getOrCreateDeviceToken } from "./token-store.js";

const GATEWAY_PREFIX = "/api/web/v1/web3-wallet/web3wallet";

export function getGatewayPrefix(): string {
  return GATEWAY_PREFIX;
}

// web3_v2 签名凭证默认值取 prod（与 DEFAULT_AI_GATEWAY_URL 默认 prod 对齐）。
// 与 plugin-web 一致：dev=key7/secret7，prod=4bda.../bcc...（gt-api/index.ts 内 isDev 分支）。
// 测试环境由 .env 的 BW_APP_KEY=key7 / BW_APP_SECRET=secret7 覆盖。
const DEFAULT_BW_APP_KEY = "4bda84eb78310b68";
const DEFAULT_BW_APP_SECRET = "bcc71f4ef3c7e644d6748d33c404b41a";

function getAppKey(): string {
  return process.env["BW_APP_KEY"] ?? DEFAULT_BW_APP_KEY;
}

function getAppSecret(): string {
  return process.env["BW_APP_SECRET"] ?? DEFAULT_BW_APP_SECRET;
}

// ── 工具 ─────────────────────────────────────────────────────────

function md5Hex(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

/**
 * 计算 x-gtweb3-appsign —— 与 plugin-web `getAppSign` 算法对齐：
 *   md5(APP_KEY + METHOD + path + queryStr + bodyStr + headerStr + APP_SECRET)
 *
 * path 已剥掉网关前缀；query / header 按 lowercase(key) 排序后 "keyvalue" 拼接。
 */
function computeAppSign(
  appKey: string,
  appSecret: string,
  method: string,
  fullUrl: string,
  body: unknown,
  signHeaders: Record<string, string>,
): string {
  const u = new URL(fullUrl);
  let path = u.pathname;
  if (path.startsWith(GATEWAY_PREFIX)) path = path.slice(GATEWAY_PREFIX.length);

  let searchStr = "";
  if (u.search.length > 1) {
    const entries: Array<[string, string]> = [];
    u.searchParams.forEach((v, k) => entries.push([k, v]));
    entries.sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
    searchStr = entries.map(([k, v]) => `${k.toLowerCase()}${v}`).join("");
  }

  const paramsStr =
    method.toUpperCase() === "POST" && body != null ? JSON.stringify(body) : "";

  const headerKeys = Object.keys(signHeaders)
    .slice()
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const headerStr = headerKeys
    .map((k) => `${k.toLowerCase()}${signHeaders[k]}`)
    .join("");

  return md5Hex(
    appKey +
      method.toUpperCase() +
      path +
      searchStr +
      paramsStr +
      headerStr +
      appSecret,
  );
}

// ── API envelope ─────────────────────────────────────────────────

interface ApiEnvelope<T = unknown> {
  code: number;
  message?: string;
  msg?: string;
  data: T;
  timestamp?: number;
  extra?: { errDetail?: string; [k: string]: unknown };
}

export class GatewayApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly code: number,
    message: string,
    public readonly raw: unknown,
  ) {
    super(`Gateway [${path}] code=${code}: ${message}`);
    this.name = "GatewayApiError";
  }
}

// ── Client ──────────────────────────────────────────────────────

export interface GatewayApiClientOpts {
  accessToken: string;
  appKey?: string;
  appSecret?: string;
  deviceToken?: string;
  version?: string;
  /** 追加到每个请求的额外 headers（非签名头），例如 `x-gtweb3-source`。 */
  extraHeaders?: Record<string, string>;
}

export class GatewayApiClient {
  private readonly accessToken: string;
  private readonly deviceToken: string;
  private readonly version: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: GatewayApiClientOpts) {
    this.accessToken = opts.accessToken;
    this.appKey = opts.appKey ?? getAppKey();
    this.appSecret = opts.appSecret ?? getAppSecret();
    this.deviceToken = opts.deviceToken ?? getOrCreateDeviceToken();
    this.version = opts.version ?? "1.0.0";
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  /** 构建参与签名的 gt-header 集合（和 plugin-web gt-fetch 对齐）。 */
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

  private buildAllHeaders(
    method: string,
    url: string,
    body: unknown,
  ): Record<string, string> {
    const signHeaders = this.buildSignHeaders();
    const appsign = computeAppSign(
      this.appKey,
      this.appSecret,
      method,
      url,
      body,
      signHeaders,
    );
    // 注：动态 gateway 不经 AI 网关，不注入 x-aiweb3-client 头（见《AI 网关统一接入》方案 §2.2）。
    return {
      ...signHeaders,
      "x-gtweb3-appsign": appsign,
      Authorization: `Bearer ${this.accessToken}`,
      ...this.extraHeaders,
    };
  }

  /** 根据动态域名 + 网关前缀 + 路由拼 URL；query 自动拼接。 */
  private async buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<string> {
    let domain = await getPrimaryWeb3Domain();
    if (!domain) {
      // 缓存失效/域名不可用时尝试刷新一次
      const refreshed = await refreshWeb3Domains();
      domain = refreshed.find((d) => d.available !== false)?.host ?? "";
    }
    if (!domain) throw new Error("no available web3 domain");
    const base = `${domain}${GATEWAY_PREFIX}${path.startsWith("/") ? path : "/" + path}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  /**
   * GET 请求。返回 envelope 里的 `data`，非 0 code 抛 `GatewayApiError`。
   */
  async get<T = unknown>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = await this.buildUrl(path, query);
    const headers = this.buildAllHeaders("GET", url, null);
    return this.request<T>("GET", url, headers);
  }

  /**
   * POST 请求。返回 envelope 里的 `data`。
   */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = await this.buildUrl(path);
    const headers = this.buildAllHeaders("POST", url, body);
    headers["Content-Type"] = "application/json";
    return this.request<T>("POST", url, headers, body);
  }

  /**
   * POST 请求，返回原始响应（不拆 `{code, data}` envelope）。
   * 用于 JSON-RPC 代理（返回 `{jsonrpc, id, result}`）等非标准 envelope 的端点。
   */
  async postRaw<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = await this.buildUrl(path);
    const headers = this.buildAllHeaders("POST", url, body);
    headers["Content-Type"] = "application/json";
    return this.requestRaw<T>("POST", url, headers, body);
  }

  private async requestRaw<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    if (process.env["DEBUG_API"]) {
      console.log(`\n[GW] ${method} ${url}`);
      console.log("[GW] headers:", JSON.stringify(headers, null, 2));
      if (body) console.log("[GW] body:", JSON.stringify(body));
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (process.env["DEBUG_API"]) {
      console.log(`[GW] status: ${res.status}`);
      console.log(`[GW] response: ${text.slice(0, 800)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Gateway [${new URL(url).pathname}] non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  private async request<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    if (process.env["DEBUG_API"]) {
      console.log(`\n[GW] ${method} ${url}`);
      console.log("[GW] headers:", JSON.stringify(headers, null, 2));
      if (body) console.log("[GW] body:", JSON.stringify(body));
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (process.env["DEBUG_API"]) {
      console.log(`[GW] status: ${res.status}`);
      console.log(`[GW] response: ${text.slice(0, 800)}`);
    }

    const path = new URL(url).pathname;
    let parsed: ApiEnvelope<T>;
    try {
      parsed = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      throw new Error(`Gateway [${path}] HTTP ${res.status} non-JSON: ${text.slice(0, 300)}`);
    }
    if (parsed.code !== 0) {
      const msg = parsed.message ?? parsed.msg ?? "unknown";
      const detail = parsed.extra?.errDetail ? `\n  Detail: ${parsed.extra.errDetail}` : "";
      const hint = parsed.code === undefined
        ? ` (HTTP ${res.status}, raw: ${text.slice(0, 200)})`
        : "";
      throw new GatewayApiError(path, parsed.code, msg + hint + detail, parsed);
    }
    return parsed.data;
  }
}

// 保留给单测使用
export const _internals = { computeAppSign };

// ── Factory + 业务封装 ────────────────────────────────────────────

export function createGatewayApiClient(accessToken: string): GatewayApiClient {
  return new GatewayApiClient({ accessToken });
}

// ── 类型（按需补充，从 plugin-web 的 TokenListApi 对齐） ──────

export interface GatewayTokenListReq {
  accountID: string;
  isManageToken?: string;          // "0" / "1"
  networkKeyList?: string[];
  page?: number;
  pageSize?: number;
}

export interface GatewayTokenListCoin {
  coinID: string;
  gateSymbol?: string;
  coinSimpleName: string;
  coinFullName: string;
  coinImage?: string;
  coinUnitPrice?: string;
  originCoinUnitPrice?: string;
  coinAmount?: string;
  originCoinAmount?: string;
  coinNumber?: string;
  originCoinNumber?: string;
  coinPrecision?: string;
  coinRiseFallRatio?: string;
  coinIsCertified?: boolean;
  coinChainNames?: string[];
  selectChainNames?: string[];
  [k: string]: unknown;
}

export interface GatewayTokenListResp {
  accountID: string;
  accountTotalAmount?: string;
  originAccountTotalAmount?: string;
  accountTotalAmountFormat?: string;
  coinArrValidate?: GatewayTokenListCoin[];
  hotTokenList?: GatewayTokenListCoin[];
  continue?: boolean;
  page?: number;
  pageSize?: number;
  pageCount?: number;
  totalCount?: number;
  [k: string]: unknown;
}

/**
 * POST /wallet/token-list（网关版 dex_wallet_get_token_list）
 */
export async function gatewayTokenList(
  client: GatewayApiClient,
  req: GatewayTokenListReq,
): Promise<GatewayTokenListResp> {
  const body = {
    accountID: req.accountID,
    isManageToken: req.isManageToken ?? "0",
    networkKeyList: req.networkKeyList ?? [],
    page: req.page ?? 1,
    pageSize: req.pageSize ?? 20,
  };
  return client.post<GatewayTokenListResp>("/wallet/token-list", body);
}

// ── 总资产 / 涨跌幅 ─────────────────────────────────────────────

export interface GatewayTotalAssetResp {
  accountID: string;
  accountTotalAmount?: string;          // "$0.00"
  originAccountTotalAmount?: string;     // "0.00"
  accountTotalAmountFormat?: string;
  priceFluctuation?: {
    fluctuationTotal?: string;
    originFluctuationTotal?: string;
    fluctuationPercentage?: string;
    originFluctuationPercentage?: string;
    snapshotFluctuationRate?: string;
    snapshotFluctuationTotal?: string;
    fluctuationType?: number;            // 0 / 1 (涨/跌)
  };
  [k: string]: unknown;
}

/**
 * POST /wallet/total-asset（网关版 dex_wallet_get_total_asset）—— 总资产 + 涨跌幅
 *
 * 同 /wallet/token-list 的参数形态（accountID / isManageToken / networkKeyList）。
 */
export async function gatewayTotalAsset(
  client: GatewayApiClient,
  req: {
    accountID: string;
    isManageToken?: string;
    networkKeyList?: string[];
  },
): Promise<GatewayTotalAssetResp> {
  return client.post<GatewayTotalAssetResp>("/wallet/total-asset", {
    accountID: req.accountID,
    isManageToken: req.isManageToken ?? "0",
    networkKeyList: req.networkKeyList ?? [],
  });
}

/**
 * GET /v1/defi/config/chain-config（网关版 dex_chain_config）
 */
export async function gatewayChainConfig<
  T = { bigNetworkKeys?: string[]; accountKeysForMainNet?: string[]; [k: string]: unknown },
>(client: GatewayApiClient): Promise<T> {
  return client.get<T>("/v1/defi/config/chain-config");
}

// ── 地址查询（agentic 公网版） ──────────────────────────────────

export interface GatewayAddressItem {
  chainType: string;                                    // "EVM" | "SOL" | "BTC" ...
  walletAddress: string[];
  walletAddressFormat: Array<{ address: string; format: string }>;
  chainList: string[];
}

export type GatewayAddressesByAccount = Record<string, GatewayAddressItem[]>;

/**
 * POST /wallet/agentic/get-addressed-by-accountid
 *
 * 根据 accountId 列表查询对应链下的钱包地址（同一个 EVM 地址会覆盖多个 chainList）。
 */
export async function gatewayGetAddressedByAccountId(
  client: GatewayApiClient,
  accountIds: string[],
): Promise<GatewayAddressesByAccount> {
  return client.post<GatewayAddressesByAccount>(
    "/wallet/agentic/get-addressed-by-accountid",
    { accountId: accountIds },
  );
}

// ── Gas 相关（EVM / Solana 网关版） ──────────────────────────

export interface GasPriceEvmResp {
  native_coin_price?: string;
  native_decimal?: number;
  low_pri_wei_per_gas?: number | string;
  avg_pri_wei_per_gas?: number | string;
  fast_pri_wei_per_gas?: number | string;
  base_wei_fee?: number | string;
  support_eip1559?: boolean;
  low_pri_cost_time?: number;
  avg_pri_cost_time?: number;
  fast_pri_cost_time?: number;
  market_price_per_gas_lv1?: number | string;
  market_price_per_gas_lv2?: number | string;
  market_price_per_gas_lv3?: number | string;
  [k: string]: unknown;
}

export interface GasPriceSolResp {
  low_microlp_per_cu?: number | string;
  avg_microlp_per_cu?: number | string;
  fast_microlp_per_cu?: number | string;
  [k: string]: unknown;
}

/** GET /gasprice/evm?chain=xxx — EVM gas price（网关版 dex_tx_gas EVM 分支） */
export async function gatewayEvmGasPrice(
  client: GatewayApiClient,
  chain: string,
  opts: { scene?: string } = {},
): Promise<GasPriceEvmResp> {
  return client.get<GasPriceEvmResp>("/gasprice/evm", {
    chain: chain.toUpperCase(),
    scene: opts.scene,
  });
}

/** POST /gaslimit/evm — EVM gas limit estimation */
export async function gatewayEvmGasLimit(
  client: GatewayApiClient,
  opts: {
    chain: string;
    from: string;
    to: string;
    value?: string;
    data?: string;
  },
): Promise<{ gas_used?: number | string; gas_base_limit_factor?: number; [k: string]: unknown }> {
  return client.post("/gaslimit/evm", {
    chain: opts.chain.toUpperCase(),
    from: opts.from,
    to: opts.to,
    value: opts.value ?? "0x0",
    data: opts.data ?? "0x",
  });
}

/** GET /gasprice/sol — Solana gas price（micro-lamports per CU） */
export async function gatewaySolGasPrice(
  client: GatewayApiClient,
  opts: { scene?: string } = {},
): Promise<GasPriceSolResp> {
  return client.get<GasPriceSolResp>("/gasprice/sol", {
    scene: opts.scene,
  });
}

/** POST /gaslimit/sol — Solana compute unit estimation */
export async function gatewaySolGasLimit(
  client: GatewayApiClient,
  data: string,
): Promise<{ units_consumed?: number | string; gas_base_limit_factor?: number; [k: string]: unknown }> {
  return client.post("/gaslimit/sol", { data });
}

// ── 广播已签名交易 ───────────────────────────────────────────────

export interface GatewaySendRawTxTrace {
  user_id?: string;
  wallet_address?: string;
  wallet_network?: string;
  wallet_source?: string;     // "plug" / "cli" / etc.
  system_type?: string;
  device_name?: string;
  system_version?: string;
  app_version?: string;
}

export interface GatewaySendRawTxHistory {
  chain_type?: string;        // "evm" | "sol" | ...
  address?: string;            // 发送方
  chain_name?: string;
  token_addr?: string;
  token_name?: string;
  token_short_name?: string;
  token_type?: string;
  trans_type?: "send";
  trans_time?: string;
  trans_balance?: string;
  trans_min_unit_amount?: string;
  trans_balance_usd?: string;
  trans_oppo_address?: string; // 接收方
  trans_gas_fee?: string;
  is_contra?: string;
  nonce?: number;
  memo?: string;
  memo_name?: string;
  [k: string]: unknown;
}

export interface GatewaySendRawTxReq {
  chain_name: string;
  /** EVM: 0x 开头 hex；Solana: base58 / base64 按后端协议 */
  params:
    | string
    | string[]
    | { tx_bytes: string; mode: string }
    | { tx: string; attachment: string }
    | Array<{ tx_blob: string }>;
  trace: GatewaySendRawTxTrace;
  history_data?: GatewaySendRawTxHistory;
  manually?: string;
  rpc_address?: string;
  account_id?: string;
}

export interface GatewaySendRawTxResp {
  hash?: string;
  hash_id?: string;
  [k: string]: unknown;
}

/** POST /trans/send-raw-transaction — 广播已签名交易（网关版 dex_tx_send_raw_transaction） */
export async function gatewaySendRawTransaction(
  client: GatewayApiClient,
  req: GatewaySendRawTxReq,
): Promise<GatewaySendRawTxResp> {
  return client.post<GatewaySendRawTxResp>("/trans/send-raw-transaction", req);
}

// ── JSON-RPC 代理（网关版 dex_rpc_call） ────────────────────────

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: JsonRpcError;
}

/**
 * 俗称 → 后端 NetworkKey 别名表。后端 proxy 只认 NetworkKey，
 * 收到不认识的 key 会返回 `rpc proxy err`。常见俗称与 key 不一致的列在此，
 * 标准 key 可用 `chain-config` 命令查询。
 */
const NETWORK_KEY_ALIASES: Record<string, string> = {
  POLYGON: "MATIC",
  POL: "MATIC",
  POLYGON_ZKEVM: "ZK_MATIC",
  ZKEVM: "ZK_MATIC",
  OP: "OPT",
  OPTIMISM: "OPT",
  ARBITRUM: "ARB",
  ARBITRUM_ONE: "ARB",
  AVALANCHE: "AVAX",
  ETHEREUM: "ETH",
  BNB: "BSC",
  BINANCE: "BSC",
  SOLANA: "SOL",
};

/** 把用户传入的链名归一化为后端 NetworkKey（大写 + 别名映射）。 */
export function normalizeNetworkKey(chain: string): string {
  const upper = chain.trim().toUpperCase();
  return NETWORK_KEY_ALIASES[upper] ?? upper;
}

/**
 * POST /unify/proxy-node/rpc/{chain}
 * chain 是 NetworkKey（ETH / BSC / SOL / MATIC ...，**大写**）；
 * 俗称（POLYGON/OP 等）会经 {@link normalizeNetworkKey} 映射到后端 key。
 *
 * 返回原始 JSON-RPC 响应；调用方需自己处理 `result` / `error`。
 */
export async function gatewayRpcCall<T = unknown>(
  client: GatewayApiClient,
  opts: {
    chain: string;
    method: string;
    params?: unknown[];
    id?: number | string;
  },
): Promise<JsonRpcResponse<T>> {
  const body = {
    jsonrpc: "2.0",
    method: opts.method,
    params: opts.params ?? [],
    id: opts.id ?? 1,
  };
  const path = `/unify/proxy-node/rpc/${encodeURIComponent(normalizeNetworkKey(opts.chain))}`;
  return client.postRaw<JsonRpcResponse<T>>(path, body);
}

// ── 交易历史 & 详情 ──────────────────────────────────────────────

export interface GatewayTransListReq {
  account_id: string;
  page_num?: number;
  page_size?: number;
  start_time?: string;
  end_time?: string;
  token_addr?: string;
  protocol?: string;
  has_confirm?: 0 | 1;
  [k: string]: unknown;
}

/** POST /trans/v2/list — 交易历史（网关版 dex_tx_list） */
export async function gatewayTransList(
  client: GatewayApiClient,
  req: GatewayTransListReq,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    get_msg: false,
    is_hidden: false,
    merge: true,
    chain_address_format: "",
    structure_network_key: "",
    page_num: 1,
    page_size: 20,
    ...req,
  };
  return client.post("/trans/v2/list", body);
}

/** POST /trans/v2/detail — 交易详情（网关版 dex_tx_detail） */
export async function gatewayTransDetail(
  client: GatewayApiClient,
  hashId: string | string[],
  fromWallet?: string[],
): Promise<unknown> {
  return client.post("/trans/v2/detail", {
    hash_id: Array.isArray(hashId) ? hashId : [hashId],
    from_wallet: fromWallet ?? [],
  });
}

/** Get EVM nonce via gateway RPC proxy */
export async function gatewayGetEvmNonce(
  client: GatewayApiClient,
  chain: string,
  address: string,
): Promise<bigint> {
  const res = await gatewayRpcCall<string>(client, {
    chain: chain.toUpperCase(),
    method: "eth_getTransactionCount",
    params: [address, "latest"],
  });
  if (res.error) throw new Error(`eth_getTransactionCount: ${res.error.message}`);
  const hex = (res.result ?? "0x0").replace(/^0x/i, "");
  return hex === "" ? 0n : BigInt("0x" + hex);
}

/** Get Solana latest finalized blockhash via gateway RPC proxy */
export async function gatewayGetSolanaBlockhash(
  client: GatewayApiClient,
): Promise<string> {
  const res = await gatewayRpcCall<{ value?: { blockhash?: string } }>(client, {
    chain: "SOL",
    method: "getLatestBlockhash",
    params: [{ commitment: "finalized" }],
  });
  if (res.error) throw new Error(`getLatestBlockhash: ${res.error.message}`);
  const bh = res.result?.value?.blockhash?.trim() ?? "";
  if (!bh) throw new Error("getLatestBlockhash: empty blockhash");
  return bh;
}

/** Get ERC20 token decimals via gateway RPC proxy */
export async function gatewayGetERC20Decimals(
  client: GatewayApiClient,
  chain: string,
  contractAddr: string,
): Promise<number> {
  const res = await gatewayRpcCall<string>(client, {
    chain: chain.toUpperCase(),
    method: "eth_call",
    params: [{ to: contractAddr, data: "0x313ce567" }, "latest"],
  });
  if (res.error) throw new Error(`decimals(): ${res.error.message}`);
  const hex = (res.result ?? "0x0").replace(/^0x/i, "") || "0";
  const n = Number(BigInt("0x" + hex));
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`invalid decimals: ${res.result}`);
  return n;
}
