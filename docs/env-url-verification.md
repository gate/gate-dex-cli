# 环境域名验证清单

记录各环境（test / pre / prod）下每个 base URL 的连通性与功能验证结果。
验证方式：用对应 env 启动 CLI，跑相关命令，确认返回正确数据。

**Legend**
- ☐ 未验证
- ✅ 已验证通过
- ❌ 验证失败（记录原因）
- ⚠️ 部分通过 / 待确认

---

## 1. GV_URL — Gate Verify API

> 用途：交易签名前的安全校验（checkin 接口）
> 触发命令：任何写入类操作（transfer / swap）会先调 GV checkin

> 根域名权威源：`plugin-web/apps/background/utils/gt-api/index.ts:551-554`

| 环境 | URL | 状态 | 备注 |
|---|---|---|---|
| test | `https://test-api.web3gate.io/api/plug/v1/web3-gv-api` | ✅ | 根域名与 plugin-web 一致 |
| pre  | `https://pre-api.web3gate.io/api/plug/v1/web3-gv-api`  | ✅ | 根域名与 plugin-web 一致 |
| prod | `https://api.web3gate.io/api/plug/v1/web3-gv-api`       | ✅ | 根域名与 plugin-web 一致 |

---

## 2. CDN_DOMAINS — 动态 web3_domain CDN

> 用途：拉取 web3_domain 列表（gateway-client 用的主域名来源）
> 触发命令：任何调用 gateway 网关的命令（token-list / 链配置等）

> 权威源：`web3-wallet-plugin-web/apps/background/utils/gt-remote-config.ts`（gate-dex-cli 直接复制）

| 环境 | CDN host | 状态 | 备注 |
|---|---|---|---|
| test | `web3-wallet-cdn-test.gateweb3.cc` | ✅ | 与 plugin-web 一致 |
| pre  | `web3-wallet-cdn-pre.gateweb3.cc`  | ✅ | 与 plugin-web 一致 |
| prod | `api.freshmarkethome.com/api/plug/v1/web3-wallet-cdn` | ✅ | prod 7 host 列表，与 plugin-web 一致 |
| prod | `api.freshmarketpage.com/api/plug/v1/web3-wallet-cdn` | ✅ | |
| prod | `api.gateweb3.io/api/plug/v1/web3-wallet-cdn`         | ✅ | |
| prod | `api.ldd678.com/api/plug/v1/web3-wallet-cdn`          | ✅ | |
| prod | `api.web3gate.cc/api/plug/v1/web3-wallet-cdn`         | ✅ | |
| prod | `api.web3gate.io/api/plug/v1/web3-wallet-cdn`         | ✅ | |
| prod | `web3-wallet-cdn-prod.gateweb3.cc`                    | ✅ | |

---

## 3. WEB3_DOMAIN_HOSTS — pre 环境硬编码 host

> 用途：pre 环境跳过 CDN 拉取，直接使用这些 host 作为 web3_domain
> 仅 pre 环境使用；dev / prod 走 CDN 动态拉取

> 权威源：`web3-wallet-plugin-web/apps/background/utils/gt-remote-config.ts:430-432`（gate-dex-cli 直接复制）

| 环境 | host | 状态 | 备注 |
|---|---|---|---|
| pre | `http://pre-api.ldd710.com` | ✅ | 与 plugin-web 一致 |
| pre | `http://pre-api.ldd711.com` | ✅ | 与 plugin-web 一致 |
| pre | `http://pre-api.ldd712.com` | ✅ | 与 plugin-web 一致 |

---

## 4. WALLET_SERVICE_URL — gateio-service-web3-wallet

> 用途：balance 命令查询余额

| 环境 | URL | 状态 | 备注 |
|---|---|---|---|
| test | `https://web3-wallet-service-test.gateweb3.cc` | ✅ | 服务查询确认 |
| pre  | `https://web3-wallet-service-pre.gateweb3.cc`  | ✅ | 服务查询确认 |
| prod | `https://web3-wallet-service-prod.gateweb3.cc` | ✅ | 服务查询确认；另有备用域名 `https://web3-wallet-service-prod.w3-api.com` |

---

## 5. BW_SERVICE_URL — web3-business-wallet 服务

> 用途：BW 托管钱包业务接口

| 环境 | URL | 状态 | 备注 |
|---|---|---|---|
| test | `https://web3-business-wallet-test.gateweb3.cc` | ✅ | 服务查询确认 |
| pre  | `https://web3-business-wallet-pre.gateweb3.cc`  | ✅ | 服务查询确认 |
| prod | `http://web3-ingress-prod.gateweb3.io/web3-business-wallet`（内网） | ⚠️ | 服务注册中心未暴露公网域名；源码默认值已改为内网入口，公网部署必须通过 `BW_SERVICE_URL` 注入 |

---

## 6. MARKET_TOKEN_URL — gateio_service_web3_trade_token

> 用途：市场行情、Token 列表、Swap quote/build/submit

| 环境 | URL | 状态 | 备注 |
|---|---|---|---|
| test | `https://apipro-test-new.gateweb3.cc` | ☐ | |
| pre  | `https://apipro-pre-new.gateweb3.cc`  | ☐ | 审计文档原标 (待确认) |
| prod | `https://apipro-new.gateweb3.cc`      | ☐ | 审计文档原标 (待确认) |

---

## 7. DATA_API_URL — web3-data-api

> 用途：Token 详情、安全审计、排行榜

| 环境 | URL | 状态 | 备注 |
|---|---|---|---|
| test | `https://web3-data-api-test.gateweb3.cc` | ✅ | 服务查询确认 |
| pre  | `https://web3-data-api-pre.gateweb3.cc`  | ✅ | 服务查询确认 |
| prod | `https://web3-data-api-prod.gateweb3.cc` | ✅ | 已修源码默认值（加 `-prod` 后缀） |

---

## 8. BIZ_WALLET_URL — web3-business-wallet 网关（登录）

> 用途：OAuth 登录会话（device/start、device/poll）
> ⚠️ pre 与 prod 共用同一域名，没有独立 pre URL

| 环境 | URL | 状态 | 备注 |
|---|---|---|---|
| test     | `https://webapi-test.gateweb3.cc/api/web/v1/web3-business-wallet` | ☐ | |
| pre/prod | `https://webapi.gateweb3.cc/api/web/v1/web3-business-wallet`      | ☐ | pre/prod 共用 |

---

## 验证步骤模板

每个环境的验证命令（按测试 / pre / prod 切换 .env 后执行）：

```bash
# 1. 登录验证 BIZ_WALLET_URL
gate-dex login

# 2. 查询余额验证 WALLET_SERVICE_URL
gate-dex wallet balance

# 3. token 列表验证 gateway（CDN_DOMAINS / WEB3_DOMAIN_HOSTS）
gate-dex market token-list

# 4. token 详情验证 DATA_API_URL
gate-dex market token-detail <token>

# 5. swap 报价验证 MARKET_TOKEN_URL
gate-dex swap quote ...

# 6. 任意写操作验证 GV_URL
gate-dex transfer ... # 或 swap submit
```

## 已知风险点

1. 审计文档原始注释里 `web3-business-wallet-prod`、`apipro-new`、`apipro-pre-new` 标了 **(待确认)** —— 这几个 prod/pre 域名在合并前需手工确认线上是否真的就是这些。
2. `BIZ_WALLET_URL` pre/prod 共用 `webapi.gateweb3.cc`，pre 测试时如果直连 prod 域名会污染 prod 数据，需注意。
3. `WEB3_DOMAIN_HOSTS` 用的是 `http://`（非 https），需确认是不是当前实际行为。
