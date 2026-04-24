# 快速上手

## 环境准备

- **Node.js >= 18** — 推荐通过 [nvm](https://github.com/nvm-sh/nvm) 或 [Node.js 官网](https://nodejs.org/) 安装

## 安装

```bash
# 方式一：npm 全局安装（推荐）
npm install -g gate-dex-cli

# 方式二：npx 免安装运行
npx gate-dex-cli login
```

## 登录

```bash
gate-dex login              # Gate OAuth 登录（浏览器授权）
gate-dex login --google     # Google OAuth 登录
gate-dex status             # 查看登录状态
```

Token 自动保存到 `~/.gate-dex/auth.json`，30 天有效，无需重复登录。

> **三方注入**：如果由其他工具直接写入 `auth.json`，可通过 `--auth-file` 指定路径，无需走登录流程：
> ```bash
> gate-dex --auth-file /path/to/auth.json status
> ```

## 基本用法

```bash
# 钱包查询
gate-dex balance            # 查询总资产余额
gate-dex address            # 查询各链钱包地址（EVM / SOL）
gate-dex tokens             # 查询 Token 列表和余额

# 一键转账
gate-dex send --chain ETH --to 0x... --amount 0.0001
gate-dex send --chain SOL --to <address> --amount 0.001

# Swap 兑换（ETH → USDT）
gate-dex swap --from-chain 1 --from - --to 0xdAC17F958D2ee523a2206206994597C13D831ec7 --amount 0.01 --native-in 1

# Gas 费用查询
gate-dex gas ETH
gate-dex gas SOL
```

## 交互模式

```bash
gate-dex                    # 进入交互模式
```

```
Gate Dex CLI - Interactive Mode
Type 'login' to start, 'help' for all commands, 'exit' to quit.

gate-dex> login
gate-dex> balance
gate-dex> exit
```

## 更多

完整命令参考、支持的链列表和配置说明，请查看 [README](../README.md)。
