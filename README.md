# Gate Dex CLI

A command-line interface for [Gate](https://gate.com) Web3 wallet. Supports balance queries, transfers, Swap, market data, and token analytics via the REST API. Designed for developers, quants, and AI agents.

## Quick Start

- [English Quick Start](docs/quickstart.md)
- [中文快速上手](docs/quickstart_zh.md)

## Features

- **REST API** — OAuth + custodial signing
- **Multi-chain** — EVM chains (Ethereum, BSC, Arbitrum, Base, Polygon, etc.), Solana, Tron, Sui, TON
- **Wallet** — balance, addresses, tokens, one-click transfers (preview→sign→broadcast)
- **Swap** — full lifecycle: quote → build → sign → submit → status tracking
- **Market data** — K-line, liquidity, trade volume, token rankings, security audits
- **Two modes** — single-command or interactive REPL with persistent session
- **AI Agent ready** — structured output for scripting and agent integration

## Installation

### npm global install (recommended)

```bash
npm install -g gate-dex-cli
gate-dex login
```

### npx (no install)

```bash
npx gate-dex-cli login
npx gate-dex-cli balance
```

### From source

```bash
git clone <repo-url>
cd gate-dex-cli/cli
pnpm install
pnpm cli login
```

## Configuration

```bash
# OAuth login (token saved to ~/.gate-dex/auth.json, 30-day expiry)
gate-dex login              # Gate OAuth
gate-dex login --google     # Google OAuth
```

Or configure manually:

| Path                              | Purpose                      |
| --------------------------------- | ---------------------------- |
| `~/.gate-dex/auth.json`        | OAuth token (auto-generated) |

### Custom auth file path

Use `--auth-file` to point the CLI at an `auth.json` written by a third party (no login flow needed):

```bash
gate-dex --auth-file /path/to/auth.json status
gate-dex --auth-file /path/to/auth.json balance
```

Or set the env variable: `GATE_DEX_AUTH_FILE=/path/to/auth.json gate-dex balance`

`--auth-file` takes precedence over `--auth-dir` / `GATE_DEX_HOME`.

## Usage examples

```bash
# Auth
gate-dex login
gate-dex logout

# Wallet queries
gate-dex balance
gate-dex address
gate-dex tokens

# One-click transfer
gate-dex send --chain ETH --to 0x... --amount 0.0001
gate-dex send --chain SOL --to <address> --amount 0.001
gate-dex send --chain ETH --to 0x... --amount 1 --token 0xdAC17F...   # ERC20

# Swap
gate-dex swap --from-chain 1 --from - --to 0xdAC17F... --amount 0.01 --native-in 1
gate-dex swap-detail <order_id>

# Market data
gate-dex kline --chain eth --address 0x...
gate-dex token-rank --chain eth --limit 10
gate-dex token-risk --chain eth --address 0x...

# Interactive REPL
gate-dex
```

## Command reference

### Auth & Wallet

| Command            | Description                  |
| ------------------ | ---------------------------- |
| `login [--google]` | OAuth login (Gate or Google) |
| `logout`           | Clear token                  |
| `web3-domain`      | View/refresh web3 domain list |
| `balance`          | Total asset balance          |
| `address`          | Wallet addresses (EVM/SOL)   |
| `tokens`           | Token list with balances     |

### Transfer

| Command                                                   | Description                                 |
| --------------------------------------------------------- | ------------------------------------------- |
| `send --chain <c> --to <addr> --amount <n>`               | One-click transfer (preview→sign→broadcast) |
| `gas [chain]`                                             | Gas fees                                    |
| `transfer --chain <c> --to <addr> --amount <n>`           | Transfer preview only                       |
| `sign-msg <message>`                                      | Sign message                                |
| `sign-tx <raw_tx>`                                        | Sign raw transaction (with GV safety check) |
| `send-tx --chain <c> --hex <tx> --to <addr> --amount <n>` | Broadcast signed tx                         |
| `sol-tx --chain SOL --to <addr> --amount <n>`             | Build Solana unsigned transfer tx           |
| `tx-detail <tx_hash>`                                     | Transaction details                         |
| `tx-history [--limit N]`                                  | Transaction history                         |

### Swap

| Command                                                          | Description              |
| ---------------------------------------------------------------- | ------------------------ |
| `quote --from-chain <id> --from <addr> --to <addr> --amount <n>` | Get swap quote           |
| `swap --from-chain <id> --from <addr> --to <addr> --amount <n>`  | One-click swap           |
| `swap-detail <order_id>`                                         | Swap transaction details |
| `swap-history [--limit N]`                                       | Swap/bridge history      |

### Market & Token

| Command                                          | Description                      |
| ------------------------------------------------ | -------------------------------- |
| `kline --chain <c> --address <addr>`             | K-line data                      |
| `liquidity --chain <c> --address <addr>`         | Liquidity pool events            |
| `tx-stats --chain <c> --address <addr>`          | Trade volume (5m/1h/4h/24h)      |
| `token-info --chain <c> --address <addr>`        | Token details (price/market cap) |
| `token-risk --chain <c> --address <addr>`        | Security audit                   |
| `token-rank --chain <c> [--limit N]`             | Top gainers/losers (24h)         |
| `new-tokens --chain <c> --start <ISO>`           | New tokens by creation time      |
| `swap-tokens --chain <c> [--search <q>]`         | Swappable tokens                 |
| `bridge-tokens --src-chain <c> --dest-chain <c>` | Cross-chain bridge targets       |

### Chain & Advanced

| Command                        | Description                |
| ------------------------------ | -------------------------- |
| `chain-config [chain]`         | Chain configuration        |
| `rpc --chain <c> --method <m>` | JSON-RPC call              |
| `cleanup`                      | Remove local config files  |

## Swap parameters

| Flag           | Description                              |
| -------------- | ---------------------------------------- |
| `--from-chain` | Source chain ID (ETH=1, BSC=56, SOL=501) |
| `--to-chain`   | Destination chain ID                     |
| `--from`       | Source token address (`-` for native)    |
| `--to`         | Target token address                     |
| `--amount`     | Amount to swap                           |
| `--native-in`  | Source is native coin (1/0)              |
| `--native-out` | Target is native coin (1/0)              |
| `--slippage`   | Slippage tolerance (0.03 = 3%)           |

## Supported chains

| Chain     | Chain ID | Parameter |
| --------- | -------- | --------- |
| Ethereum  | 1        | ETH       |
| BSC       | 56       | BSC       |
| Polygon   | 137      | POLYGON   |
| Arbitrum  | 42161    | ARB       |
| Base      | 8453     | BASE      |
| Optimism  | 10       | OP        |
| Avalanche | 43114    | AVAX      |
| Solana    | 501      | SOL       |
| Fantom    | 250      | FTM       |
| Cronos    | 25       | cronos    |
| Linea     | 59144    | linea     |
| Scroll    | 534352   | scroll    |
| zkSync    | 324      | zksync    |
| Mantle    | 5000     | mantle    |
| GateLayer | 10088    | gatelayer |
| Tron      | 195      | TRX       |
| Sui       | 101      | sui       |
| TON       | 607      | ton       |

## Documentation

| Document                                       | Description               |
| ---------------------------------------------- | ------------------------- |
| [docs/quickstart.md](docs/quickstart.md)       | English quick start guide |
| [docs/quickstart_zh.md](docs/quickstart_zh.md) | 中文快速上手              |

## Tech stack

- **Runtime**: Node.js >= 18 + TypeScript
- **CLI**: Commander.js
- **Auth**: Google / Gate OAuth 2.0
- **REST API**: Direct HTTP calls to Gate wallet services

## AI Agent integration

> AI Agent Skills have been migrated to **[web3-wallet-skill](https://github.com/gate/gate-skills/tree/master/skills/gate-dex-wallet)** — visit that repo for installation and usage.
