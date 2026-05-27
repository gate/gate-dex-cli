#!/usr/bin/env bash
# gate-dex-cli 端到端冒烟测试
#
# 跑一遍走 AI 网关的命令，逐条判 pass/fail，最后汇总。
#
# 用法:
#   scripts/e2e-test.sh                      # 默认 AI_GATEWAY_URL=https://api-test.gate-cli.com
#   AI_GATEWAY_URL=https://xxx scripts/e2e-test.sh
#   scripts/e2e-test.sh --write              # 额外跑会真实上链的命令(send/swap)，慎用
#   TOKEN=0x... CHAIN=eth scripts/e2e-test.sh
#
# 说明:
#   - 登录态从 ~/.gate-dex/auth.json 读；未登录则只跑无需登录的命令并提示。
#   - 自动探测网关可达 IP：直连不通时(NLB 跨 AZ 抖动)自动 pin 到一个可达的 A 记录 IP。
#   - 默认不跑会动钱的命令(send/swap/send-tx)，需 --write 显式开启。

set -uo pipefail
cd "$(dirname "$0")/.."   # -> cli/

GATEWAY="${AI_GATEWAY_URL:-https://api-test.gate-cli.com}"
CHAIN="${CHAIN:-eth}"
TOKEN="${TOKEN:-0xdAC17F958D2ee523a2206206994597C13D831ec7}"   # USDT on eth
RUN_WRITE=0
[[ "${1:-}" == "--write" ]] && RUN_WRITE=1

HOST=$(echo "$GATEWAY" | sed -E 's#^https?://##; s#/.*$##')
RUNNER="scripts/_e2e-runner.mjs"

GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
PASS=0; FAIL=0; SKIP=0
declare -a RESULTS

# ── 1. 网关可达性探测 + 自动 pin ───────────────────────────────
echo "${DIM}网关: $GATEWAY${RST}"
export GATE_DEX_PIN_HOST=""
export GATE_DEX_PIN_IP=""
if curl -sS --connect-timeout 4 --max-time 8 -o /dev/null "https://$HOST/" 2>/dev/null; then
  echo "${GREEN}直连可达，使用系统 DNS${RST}"
else
  echo "${YEL}直连不可达，探测 NLB A 记录…${RST}"
  CNAME=$(dig +short "$HOST" | grep -E 'amazonaws|elb' | head -1)
  CANDIDATES=$( { dig +short "$HOST"; [[ -n "$CNAME" ]] && dig +short "$CNAME"; } | grep -E '^[0-9]+\.' | sort -u )
  for ip in $CANDIDATES; do
    if curl -sS --resolve "$HOST:443:$ip" --connect-timeout 3 --max-time 6 -o /dev/null "https://$HOST/" 2>/dev/null; then
      export GATE_DEX_PIN_HOST="$HOST"
      export GATE_DEX_PIN_IP="$ip"
      echo "${GREEN}pin $HOST -> $ip${RST}"
      break
    fi
  done
  if [[ -z "$GATE_DEX_PIN_IP" ]]; then
    echo "${RED}没有找到可达 IP，网关侧不通，测试中止${RST}"
    exit 1
  fi
fi

# ── 登录态 ─────────────────────────────────────────────────────
AUTH_FILE="${GATE_DEX_AUTH_FILE:-$HOME/.gate-dex/auth.json}"
LOGGED_IN=0
if [[ -f "$AUTH_FILE" ]] && grep -q mcp_token "$AUTH_FILE" 2>/dev/null; then
  LOGGED_IN=1
  echo "${GREEN}已登录${RST}"
else
  echo "${YEL}未登录 —— 仅跑无需登录的命令${RST}"
fi
echo

# ── 执行单条命令并判定 ─────────────────────────────────────────
# run <label> <needs_login:0|1> -- <cli args...>
run() {
  local label="$1"; local need_login="$2"; shift 2
  [[ "$1" == "--" ]] && shift
  if [[ "$need_login" == "1" && "$LOGGED_IN" == "0" ]]; then
    printf "  %-42s ${YEL}SKIP${RST} (需登录)\n" "$label"
    RESULTS+=("SKIP $label"); ((SKIP++)); return
  fi
  local out
  out=$(AI_GATEWAY_URL="$GATEWAY" npx tsx "$RUNNER" "$@" 2>&1)
  if echo "$out" | grep -qE 'fetch failed|✖|Error:|API 请求失败|Not logged in|Unable to connect|error \(|unknown error'; then
    printf "  %-42s ${RED}FAIL${RST}\n" "$label"
    echo "$out" | grep -E 'fetch failed|✖|Error:|API 请求失败|Not logged in|Unable to connect|error \(|unknown error' | head -1 | sed "s/^/      ${DIM}/; s/$/${RST}/"
    RESULTS+=("FAIL $label"); ((FAIL++))
  else
    printf "  %-42s ${GREEN}PASS${RST}\n" "$label"
    RESULTS+=("PASS $label"); ((PASS++))
  fi
}

echo "── 行情 / Token 数据(无需登录) ──"
run "kline"            0 -- kline --chain "$CHAIN" --address "$TOKEN" --limit 1
run "liquidity"        0 -- liquidity --chain "$CHAIN" --address "$TOKEN" --size 1
run "tx-stats"         0 -- tx-stats --chain "$CHAIN" --address "$TOKEN"
run "swap-tokens"      0 -- swap-tokens --chain "$CHAIN" --tag recommend
run "bridge-tokens"    0 -- bridge-tokens --src-chain "$CHAIN" --dest-chain bsc
run "token-info"       0 -- token-info --chain "$CHAIN" --address "$TOKEN"
run "token-risk"       0 -- token-risk --chain "$CHAIN" --address "$TOKEN"
run "token-rank"       0 -- token-rank --chain "$CHAIN" --limit 1
run "new-tokens"       0 -- new-tokens --chain "$CHAIN" --limit 1
run "web3-domain"      0 -- web3-domain

echo
echo "── 登录态 / 钱包 / 签名(需登录) ──"
run "status"           1 -- status
run "address"          1 -- address
run "balance"          1 -- balance
run "tokens"           1 -- tokens --chain "$CHAIN"
run "gas"              1 -- gas --chain "$CHAIN"
run "chain-config"     1 -- chain-config
run "tx-history"       1 -- tx-history --limit 1
run "swap-history"     1 -- swap-history --limit 1
run "sign-msg"         1 -- sign-msg "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899" --chain 1
run "quote(ETH->USDT)" 1 -- quote --from-chain 1 --to-chain 1 --from - --to "$TOKEN" --amount 0.001 --native-in 1
run "transfer(preview)" 1 -- transfer --chain "$CHAIN" --to 0x381c9651cfd07a29c9e6f9d2243861db3c74c7cd --amount 0.0001

if [[ "$RUN_WRITE" == "1" ]]; then
  echo
  echo "${YEL}── 真实上链(--write) ──${RST}"
  run "send(BSC 0.0001 BNB)" 1 -- send --chain BSC --to 0x44a04fb1be798ceeeafaf7e8bd3ab6dd1ae8d044 --amount 0.0001
fi

# ── 汇总 ───────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────"
echo "  ${GREEN}PASS $PASS${RST}   ${RED}FAIL $FAIL${RST}   ${YEL}SKIP $SKIP${RST}"
if [[ "$FAIL" -gt 0 ]]; then
  echo "  失败项:"
  for r in "${RESULTS[@]}"; do [[ "$r" == FAIL* ]] && echo "    ${RED}${r#FAIL }${RST}"; done
  exit 1
fi
echo "  ${GREEN}全部通过${RST}"
