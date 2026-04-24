# Quick Start

## Prerequisites

- **Node.js >= 18** — install via [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org/)

## Install

```bash
# Option 1: npm global install (recommended)
npm install -g gate-dex-cli

# Option 2: npx (no install)
npx gate-dex-cli login
```

## Login

```bash
gate-dex login              # Gate OAuth (opens browser)
gate-dex login --google     # Google OAuth
gate-dex status             # check auth status
```

Token is saved to `~/.gate-dex/auth.json` and valid for 30 days.

> **Third-party injection**: If another tool writes `auth.json` directly, point the CLI at it with `--auth-file`:
> ```bash
> gate-dex --auth-file /path/to/auth.json status
> ```

## Basic usage

```bash
# Wallet queries
gate-dex balance            # total asset balance
gate-dex address            # wallet addresses (EVM/SOL)
gate-dex tokens             # token list with balances

# One-click transfer
gate-dex send --chain ETH --to 0x... --amount 0.0001
gate-dex send --chain SOL --to <address> --amount 0.001

# Swap (ETH → USDT)
gate-dex swap --from-chain 1 --from - --to 0xdAC17F958D2ee523a2206206994597C13D831ec7 --amount 0.01 --native-in 1

# Gas fees
gate-dex gas ETH
gate-dex gas SOL
```

## Interactive REPL

```bash
gate-dex                    # enter interactive mode
```

```
Gate Dex CLI - Interactive Mode
Type 'login' to start, 'help' for all commands, 'exit' to quit.

gate-dex> login
gate-dex> balance
gate-dex> exit
```

## Next steps

See the full [README](../README.md) for complete command reference, supported chains, and configuration details.
