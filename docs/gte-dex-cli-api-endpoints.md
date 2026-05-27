# gate-dex-cli 接口清单

本文件汇总 CLI 直接调用的所有 HTTP 接口、所属服务、用途、对应的 base URL / 环境变量，以及**每组接口携带的请求头**。

> 说明：本 CLI 用「直连 REST API」替代了原先的 MCP tool 调用。所有接口都按业务服务分组。
> BIZ_WALLET / BW_SERVICE / WALLET_SERVICE / MARKET_TOKEN / DATA_API 共 5 个服务默认走
> AI 网关（`AI_GATEWAY_URL`），GV / Gateway / CDN 维持直连；均可用对应环境变量覆盖。

---

## 1. 服务与 base URL 一览

| 服务 | 环境变量 | 默认值 | 客户端类 / 模块 |
|------|----------|--------|-----------------|
| AI 网关（统一入口） | `AI_GATEWAY_URL` | `https://api.gate-cli.com`（prod） | 整体覆盖下列 5 个服务的 base |
| 登录网关（webapi） | `BIZ_WALLET_URL` | `{AI_GATEWAY_URL}/web3-business-wallet` | `auth.cmd.ts` |
| BW 业务服务 | `BW_SERVICE_URL` | `{AI_GATEWAY_URL}/web3-business-wallet` | `BwApiClient` |
| Wallet 服务 | `WALLET_SERVICE_URL` | `{AI_GATEWAY_URL}/gateio-service-web3-wallet-service` | `WalletApiClient` |
| Swap quote | `MARKET_TOKEN_URL` | `{AI_GATEWAY_URL}/gateio-service-web3-route` | `SwapApiClient.quote` |
| Swap build | `MARKET_TOKEN_URL` | `{AI_GATEWAY_URL}/gateio-service-web3-build` | `SwapApiClient.build` |
| Swap biz（submit / history / detail） | `MARKET_TOKEN_URL` | `{AI_GATEWAY_URL}/gateio-service-web3-biz-swapapi` | `SwapApiClient.{submit,swapHistory,swapDetail}` |
| 行情（kline / liquidity / tx-stats） | `MARKET_TOKEN_URL` | `{AI_GATEWAY_URL}/gateio-service-web3-trade-tradeapi` | `MarketTradeClient` |
| Token 列表（swap-tokens / bridge-tokens） | `MARKET_TOKEN_URL` | `{AI_GATEWAY_URL}/gateio-service-web3-trade-tokenapi` | `MarketApiClient` |
| Data API | `DATA_API_URL` | `{AI_GATEWAY_URL}/gateio-service-web3-data-api` | `DataApiClient` |
| GV 安全校验 | `GV_URL` | `https://api.web3gate.io/api/plug/v1/web3-gv-api`（不经 AI 网关） | `GvClient` |
| Gateway 动态网关 | 动态 `web3_domain` + 前缀 `/api/web/v1/web3-wallet/web3wallet` | 见「动态域名发现」（不经 AI 网关） | `GatewayApiClient` |
| CDN 配置发现 | `CDN_DOMAINS` / `WEB3_DOMAIN_HOSTS` | 见 `remote-config.ts`（不经 AI 网关） | `remote-config.ts` |

> `BIZ_WALLET_URL` 与 `BW_SERVICE_URL` 接入 AI 网关后 base 相同，但仍是两个独立变量：
> 前者是登录前置流程（OAuth + merchant 凭证），后者是登录后业务调用，网关按子路径二次分发。
> 保留两个变量是为了能独立覆盖 / 降级单个服务。详见 `api-client.ts` 顶部注释。

---

## 2. 请求头总览

下面各服务章节的「请求头」一栏只列**本服务特有**的头，公共部分统一在这里说明，不再重复。

### 2.1 公共头（所有出站请求）

由 `core/client-headers.ts` 的 `clientHeaders()` 注入，**每一个请求**都带，AI 网关读取后写入 access_log：

| Header | 值 | 说明 |
|--------|----|----|
| `x-aiweb3-client` | `gate-dex-cli` | 固定值，对应 access_log 的 `client` 字段 |
| `x-aiweb3-client-version` | 如 `1.0.0` | 取自 `package.json` 版本（二进制走打包注入的版本），对应 access_log 的 `client_version` 字段 |

### 2.2 web3_v2 签名头组

`BwApiClient` 与 `GatewayApiClient` 的每个请求都带这一组头，用于 `web3_v2` 加签。后文用「**web3_v2 签名头组**」指代：

| Header | 值 |
|--------|----|
| `x-gtweb3-appKey` | appKey |
| `x-gtweb3-random` | `md5(deviceToken + time)` 取前 10 位 |
| `x-gtweb3-time` | 毫秒时间戳 |
| `x-gtweb3-applang` | `en` |
| `x-gtweb3-device-type` | `5` |
| `x-gtweb3-device-id` | 设备 token |
| `x-gtweb3-night` | `0` |
| `x-gtweb3-sign-version` | `web3_v2` |
| `x-gtweb3-version` | 客户端版本 |
| `x-gtweb3-device-token` | 设备 token |
| `x-gtweb3-appsign` | 由上述头 + 方法 + path + body 计算出的 MD5 签名 |

> `x-aiweb3-client` / `x-aiweb3-client-version` 不带 `x-gtweb3-` 前缀，**不参与** `appsign` 计算。

---

## 3. 登录 / OAuth（base：`BIZ_WALLET_URL`）

文件：`cli/src/cli/auth.cmd.ts`、`cli/src/core/api-client.ts`

**请求头**（除[公共头](#21-公共头所有出站请求)外）：

- `GET /v1/wallet/config/merchant`：`x-gtweb3-app-id: <BW_APP_ID>`
- OAuth `device/start`、`device/poll`：
  - `Content-Type: application/json`
  - `User-Agent`：`buildUserAgent()`，如 `macOS 26.2; arm64`
  - `x-gtweb3-device-token: <设备 token>`
  - `x-gtweb3-app-id: <BW_APP_ID>`（默认 `mcp_wallet_yikFT6`，可用 `BW_APP_ID` 覆盖）
  - `source: 3`

| 方法 | 路径 | 作用 |
|------|------|------|
| GET  | `/v1/wallet/config/merchant` | 动态拉取 merchant 凭证（`app_id` + `sign_secret`），用于 BW 签名；进程内缓存 |
| POST | `/v1/wallet/oauth/gate/device/start` | 启动 Gate 账号 OAuth Device Flow，返回 `flow_id` / `verification_url` |
| POST | `/v1/wallet/oauth/gate/device/poll` | 轮询 Gate 登录结果，成功后下发 `mcp_token` / `account_id` / 钱包地址 |
| POST | `/v1/wallet/oauth/google/device/start` | 启动 Google OAuth Device Flow |
| POST | `/v1/wallet/oauth/google/device/poll` | 轮询 Google 登录结果 |
| —    | `/v1/wallet/oauth/google/device/callback` | Google OAuth 服务端回调地址（由浏览器/Google 访问，非 CLI 主动调用） |

外部依赖：`https://accounts.google.com/o/oauth2/v2/auth` —— Google 官方授权页（服务端未返回 `verification_url` 时本地兜底构建）。

---

## 4. Wallet 服务（base：`WALLET_SERVICE_URL`）

文件：`cli/src/core/api-client.ts` → `WalletApiClient`

**请求头**（除公共头外）：

- `Content-Type: application/json`
- `Authorization: Bearer <mcp_token>`

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/wallet/inner/get-addressed-by-accountid` | 按 accountId 查询各链钱包地址 |
| POST | `/wallet/inner/token-list` | 查询 Token 列表与余额（支持分页 / 按 networkKey 过滤） |
| POST | `/wallet/inner/asset/total-asset` | 查询账户总资产与涨跌幅 |

---

## 5. BW 业务服务（base：`BW_SERVICE_URL`）

文件：`cli/src/core/api-client.ts` → `BwApiClient`

**请求头**（除公共头外）：

- [web3_v2 签名头组](#22-web3_v2-签名头组)
- `x-gtweb3-app-id: <BW_APP_ID>`
- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/v1/wallet/quick/sign-message` | 对消息进行钱包签名 |
| POST | `/v1/wallet/quick/sign-transaction` | 对原始未签名交易进行签名 |
| POST | `/v1/wallet/quick/logout` | 登出（带 3s 超时，失败静默忽略） |

---

## 6. GV 安全校验（base：`GV_URL`）

文件：`cli/src/core/gv-client.ts` → `GvClient`

**请求头**（除公共头外）：

- `Content-Type: application/json`
- `Accept: application/json, text/plain, */*`
- `x-gtweb3-device-token: <设备 token>`
- `Authorization: Bearer <mcp_token>`
- `api-sign` / `api-timestamp` / `api-code`：SHA256 签名三元组（算法见 `gv-client.ts`，与 web3_v2 不同）

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/api/v1/tx/checkin` | 交易签名前的安全登记，获取 `checkin_token`（再传给签名接口）；可能返回 `need_otp` |
| POST | `/api/v1/security/verify` | OTP 二次验证（`need_otp=true` 时调用） |

---

## 7. 行情 / 交易服务（base：`MARKET_TOKEN_URL`）

文件：`cli/src/core/api-client.ts`

### 7.1 MarketApiClient

**请求头**（除公共头外）：

- `X-Gtweb3-Device-Type: 3`
- `x-gtweb3-app-id: <BW_APP_ID>`
- `Authorization: Bearer <mcp_token>`

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/web3api/v2/token/swap_bridge_list` | 查询可兑换 / 跨链桥 Token 列表 |

### 7.2 MarketTradeClient

**请求头**：仅[公共头](#21-公共头所有出站请求)，无鉴权。

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/web3api/v2/trade/kline` | K 线行情数据 |
| GET | `/web3api/v2/trade/volume_stats` | 交易量统计 |
| GET | `/web3api/v2/trade/pair/liquidity/list_v2` | 流动性池事件列表 |

### 7.3 SwapApiClient（兑换交易）

**请求头**（除公共头外）：

- `x-gtweb3-trade-source`：交易来源，默认 `trade-ai`
- `x-gtweb3-app-id: <BW_APP_ID>`
- `Authorization: Bearer <mcp_token>`
- `Content-Type: application/json`：**仅 POST 方法**（GET 的 `history` 不带）

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/web3api/v3/transaction/quote` | 获取兑换报价 |
| POST | `/web3api/v3/transaction/build` | 构建 Swap 未签名交易 |
| POST | `/web3api/v3/transaction/submit` | 提交兑换交易 |
| POST | `/web3api/v3/transaction/history/swap/detail` | 查询单笔兑换详情 |
| GET  | `/web3api/v3/transaction/history` | 查询兑换历史列表 |

---

## 8. Data API（base：`DATA_API_URL`）

文件：`cli/src/core/api-client.ts` → `DataApiClient`

**请求头**（除公共头外）：

- `Content-Type: application/json`
- `Authorization: Bearer <mcp_token>`：**可选**——已登录才带，未登录不带，不影响数据返回

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/v1/base/token/query` | 通用 Token 详情查询（趋势 / 流动性 / 持有人等） |
| POST | `/v1/base/token_security/risk_infos` | 查询 Token 安全审计 / 风险信息 |

---

## 9. Gateway 动态网关（base：动态 `web3_domain` + 前缀 `/api/web/v1/web3-wallet/web3wallet`）

文件：`cli/src/core/gateway-client.ts` → `GatewayApiClient`

**请求头**（除公共头外）：

- [web3_v2 签名头组](#22-web3_v2-签名头组)（签名时 path 会剥掉网关前缀）
- `Authorization: Bearer <token>`
- `Content-Type: application/json`：仅 POST
- 可选 `extraHeaders`（构造时传入，如 `x-gtweb3-source`）

> 与 BW 业务服务不同：网关版**不带** `x-gtweb3-app-id`。

| 方法 | 路径（前缀后） | 作用 |
|------|----------------|------|
| POST | `/wallet/token-list` | 网关版 Token 列表 |
| POST | `/wallet/total-asset` | 网关版总资产 + 涨跌幅 |
| GET  | `/v1/defi/config/chain-config` | 链配置（支持的网络 key 等） |
| POST | `/wallet/agentic/get-addressed-by-accountid` | 按 accountId 查询钱包地址（agentic 公网版） |
| GET  | `/gasprice/evm` | EVM gas price |
| POST | `/gaslimit/evm` | EVM gas limit 估算 |
| GET  | `/gasprice/sol` | Solana gas price（micro-lamports/CU） |
| POST | `/gaslimit/sol` | Solana compute unit 估算 |
| POST | `/trans/send-raw-transaction` | 广播已签名交易 |
| POST | `/unify/proxy-node/rpc/{chain}` | JSON-RPC 代理（见下方 RPC 方法） |
| POST | `/trans/v2/list` | 交易历史列表 |
| POST | `/trans/v2/detail` | 交易详情 |

### 经由 `/unify/proxy-node/rpc/{chain}` 调用的 JSON-RPC 方法
| RPC 方法 | 作用 |
|----------|------|
| `eth_getTransactionCount` | 获取 EVM nonce |
| `getLatestBlockhash` | 获取 Solana 最新 finalized blockhash |
| `eth_call`（`0x313ce567` = `decimals()`） | 获取 ERC20 token 精度 |

---

## 10. 动态域名发现 / CDN 配置

文件：`cli/src/core/remote-config.ts`

**请求头**（除公共头外）：`Cache-Control: no-cache`

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `{cdn}/v1/cdn/get-dynamic` | 从候选 CDN 域名拉取动态 `web3_domain` 列表 |
| GET | `{host}/speed_test` | 对各 `web3_domain` 做测速排序，选最快可用域名 |

候选 CDN 域名（可用 `CDN_DOMAINS` 覆盖，逗号分隔）：
`api.freshmarkethome.com` / `api.freshmarketpage.com` / `api.gateweb3.io` / `api.ldd678.com` /
`api.web3gate.cc` / `api.web3gate.io`（路径 `/api/plug/v1/web3-wallet-cdn`）、`web3-wallet-cdn-prod.gateweb3.cc`。
也可用 `WEB3_DOMAIN_HOSTS` 直接指定 host 列表跳过 CDN 发现。结果缓存到 `~/.gate-dex/web3-domain.json`，TTL 5 分钟。

---

## 11. 鉴权 token 速查

| token | 来源 | 用在 |
|-------|------|------|
| `mcp_token` | 登录 `device/poll` 下发，存于 `~/.gate-dex/auth.json` | Wallet / GV / Market / Swap / Data 服务的 `Authorization` |
| `access_token` | 同 `mcp_token`（`getBwAccessToken()` 直接返回它） | BW 业务服务 / Gateway 的 `Authorization` |
| `BW_APP_ID` | `BW_APP_ID` 环境变量，默认 `mcp_wallet_yikFT6` | `x-gtweb3-app-id` 头 |

> Swap（7.3）与 swap_bridge_list（7.1）要求登录后才能调用；Data API（8）的 `Authorization` 可选，匿名也能查。

---

## 12. 典型业务流程中的接口编排

- **登录**：`merchant` → `oauth/.../device/start` → `oauth/.../device/poll` → 持久化 `mcp_token`。
- **转账签名广播**：`chain-config` → `gasprice/*` + `gaslimit/*` + RPC `nonce/blockhash`
  → GV `tx/checkin` → BW `sign-transaction` → Gateway `send-raw-transaction`。
- **兑换（swap）**：`quote` → `build` → GV `tx/checkin` → BW `sign-transaction`
  →（如需授权先 `eth_call decimals` + approve 流程）→ `submit` → `swap/detail`。
