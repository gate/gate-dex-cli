/**
 * ERC20 transfer/approve calldata builders, USDT contract map, and
 * precision-safe amount parsing.
 *
 * Ported from wallet_service_mcp/internal/transfer/erc20.go
 */

// first 4 bytes of keccak256("transfer(address,uint256)")
const TRANSFER_SELECTOR = "a9059cbb";
// first 4 bytes of keccak256("approve(address,uint256)")
const APPROVE_SELECTOR = "095ea7b3";

function stripHex(s: string): string {
  const lower = s.trim().toLowerCase();
  return lower.startsWith("0x") ? lower.slice(2) : lower;
}

function leftPad64(s: string): string {
  return s.length >= 64 ? s.slice(-64) : s.padStart(64, "0");
}

/** ABI-encode calldata for `transfer(to, amount)`. amount is in smallest units. */
export function buildERC20TransferData(toAddress: string, amount: bigint): string {
  const to = stripHex(toAddress);
  if (to.length !== 40) throw new Error(`invalid address length: ${toAddress}`);
  const toPadded = leftPad64(to);
  const amountHex = leftPad64(amount.toString(16));
  return "0x" + TRANSFER_SELECTOR + toPadded + amountHex;
}

/** ABI-encode calldata for `approve(spender, amount)`. */
export function buildERC20ApproveData(spenderAddress: string, amount: bigint): string {
  const spender = stripHex(spenderAddress);
  if (spender.length !== 40)
    throw new Error(`invalid spender address length: ${spenderAddress}`);
  const spenderPadded = leftPad64(spender);
  const amountHex = leftPad64(amount.toString(16));
  return "0x" + APPROVE_SELECTOR + spenderPadded + amountHex;
}

// ── Amount parsing with precision validation ─────────────────────

/**
 * Parse a human-readable decimal string to smallest units (bigint).
 * e.g. "1.5" with decimals=6 → 1500000n.
 *
 * Returns the parsed bigint plus an optional warning string if the input had
 * more decimal places than `decimals` (excess is truncated, not rounded).
 */
export function parseAmountWithPrecisionCheck(
  amountStr: string,
  decimals: number,
  tokenSymbol: string,
): { amount: bigint; warning: string } {
  let amount = amountStr.trim();
  if (!amount) throw new Error(`invalid amount: ${amountStr}`);

  let warning = "";
  let intPart: string;
  let fracPart: string;

  if (amount.includes(".")) {
    const parts = amount.split(".");
    if (parts.length !== 2) throw new Error(`invalid amount: ${amountStr}`);
    intPart = parts[0] || "0";
    fracPart = parts[1] || "";
    if (fracPart.length > decimals) {
      const truncated = intPart + "." + fracPart.slice(0, decimals);
      warning = `Input precision exceeds ${tokenSymbol} limit (${decimals} decimals), truncated to: ${truncated}`;
      fracPart = fracPart.slice(0, decimals);
      amount = truncated;
    }
  } else {
    intPart = amount;
    fracPart = "";
  }

  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) {
    throw new Error(`invalid amount: ${amountStr}`);
  }

  const fracPadded = fracPart.padEnd(decimals, "0");
  const combined = (intPart + fracPadded).replace(/^0+/, "") || "0";
  const result = BigInt(combined);

  if (result === 0n) {
    const minAmount = decimals > 0
      ? "0." + "0".repeat(decimals - 1) + "1"
      : "1";
    throw new Error(`amount too small, minimum ${tokenSymbol} amount: ${minAmount}`);
  }

  return { amount: result, warning };
}

// ── USDT contract map (by chain key) ─────────────────────────────

const USDT_CONTRACTS: Record<string, string> = {
  eth: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  bsc: "0x55d398326f99059fF775485246999027B3197955",
  matic: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  polygon: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  arb: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  arbitrum: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  avax: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
  avalanche: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
  op: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
  optimism: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
  base: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  ftm: "0x049d68029688eAbF473097a2fC38ef61633A3C7A",
  fantom: "0x049d68029688eAbF473097a2fC38ef61633A3C7A",
};

export function getUSDTContract(chain: string): string | null {
  return USDT_CONTRACTS[chain.toLowerCase().trim()] ?? null;
}

export function getUSDTDecimals(chain: string): number {
  const key = chain.toLowerCase().trim();
  if (key === "bsc") return 18;
  if (key === "eth" || key === "ethereum") return 6;
  return 6;
}

export const SOLANA_NATIVE_DECIMALS = 9;

export function getTokenPrecisionInfo(
  token: string,
  chain: string,
): { decimals: number; minAmount: string; description: string } {
  const t = token.trim().toUpperCase();
  if (t === "USDT") {
    const decimals = getUSDTDecimals(chain);
    const minAmount = decimals > 0
      ? "0." + "0".repeat(decimals - 1) + "1"
      : "1";
    return {
      decimals,
      minAmount,
      description: `USDT supports up to ${decimals} decimals`,
    };
  }
  if (t === "ETH" || t === "NATIVE") {
    return {
      decimals: 18,
      minAmount: "0.000000000000000001",
      description: "Native token supports up to 18 decimals",
    };
  }
  if (t === "SOL") {
    return {
      decimals: SOLANA_NATIVE_DECIMALS,
      minAmount: "0.000000001",
      description: "SOL supports up to 9 decimals",
    };
  }
  return {
    decimals: 18,
    minAmount: "0.000000000000000001",
    description: "Default: supports up to 18 decimals",
  };
}
