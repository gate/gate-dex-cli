/**
 * EIP-1559 (type-2) unsigned transaction encoder.
 *
 * Produces `0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 *                       gasLimit, to, value, data, accessList])`
 * which is what BW `sign-transaction` expects as `rawUnsignedTransaction`.
 *
 * Ported from wallet_service_mcp/internal/transfer/eip1559.go
 */

function stripHex(s: string): string {
  const lower = s.trim().toLowerCase();
  return lower.startsWith("0x") ? lower.slice(2) : lower;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function bigintToBytes(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hexToBytes(hex);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ── Minimal RLP encoder (for EIP-1559 unsigned payload) ─────────

function rlpEncodeBytes(b: Uint8Array): Uint8Array {
  if (b.length === 0) return new Uint8Array([0x80]);
  if (b.length === 1 && b[0]! < 0x80) return b;
  if (b.length < 56) {
    return concat([new Uint8Array([0x80 + b.length]), b]);
  }
  const lenBytes = bigintToBytes(BigInt(b.length));
  return concat([new Uint8Array([0xb7 + lenBytes.length]), lenBytes, b]);
}

function rlpEncodeUint(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array([0x80]);
  return rlpEncodeBytes(bigintToBytes(v));
}

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  const payload = concat(items);
  if (payload.length < 56) {
    return concat([new Uint8Array([0xc0 + payload.length]), payload]);
  }
  const lenBytes = bigintToBytes(BigInt(payload.length));
  return concat([new Uint8Array([0xf7 + lenBytes.length]), lenBytes, payload]);
}

// ── Public API ───────────────────────────────────────────────────

export interface EIP1559TxParams {
  chainId: number | bigint;
  nonce: number | bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: number | bigint;
  to: string;          // 0x-prefixed or raw hex, 40 chars
  value: bigint;       // wei
  dataHex: string;     // 0x-prefixed or raw hex
}

/**
 * Build EIP-1559 unsigned transaction as `0x02 || rlp([...])` hex string.
 */
export function buildEIP1559UnsignedHex(p: EIP1559TxParams): string {
  const toHex = stripHex(p.to);
  if (toHex.length !== 40) {
    throw new Error(`invalid address length (expected 40 hex chars): ${p.to}`);
  }
  const toBytes = hexToBytes(toHex);
  const dataBytes = hexToBytes(stripHex(p.dataHex));

  const payload = rlpEncodeList([
    rlpEncodeUint(BigInt(p.chainId)),
    rlpEncodeUint(BigInt(p.nonce)),
    rlpEncodeUint(p.maxPriorityFeePerGas),
    rlpEncodeUint(p.maxFeePerGas),
    rlpEncodeUint(BigInt(p.gasLimit)),
    rlpEncodeBytes(toBytes),
    rlpEncodeUint(p.value),
    rlpEncodeBytes(dataBytes),
    rlpEncodeList([]), // empty access_list
  ]);

  const out = new Uint8Array(1 + payload.length);
  out[0] = 0x02;
  out.set(payload, 1);
  return "0x" + bytesToHex(out);
}

// ── EIP-1559 fee resolution (mirrors resolveEIP1559Fee in tx.go) ──

const DEFAULT_MAX_FEE_PER_GAS_WEI = 30_000_000_000n; // 30 gwei
const ONE_GWEI = 1_000_000_000n;

/**
 * Derive maxFeePerGas and maxPriorityFeePerGas from upstream gasprice response.
 * Uses base_wei_fee + avg_pri_wei_per_gas directly (baseFee can be 0 on BSC etc.).
 */
export function resolveEIP1559Fee(priceResp?: {
  base_wei_fee?: string | number;
  avg_pri_wei_per_gas?: string | number;
  baseWeiFee?: string | number;
  avgPriWeiPerGas?: string | number;
} | null): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (!priceResp) {
    const maxFee = DEFAULT_MAX_FEE_PER_GAS_WEI;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxFee / 2n };
  }
  const base = BigInt(
    priceResp.base_wei_fee ?? priceResp.baseWeiFee ?? 0,
  );
  const priority = BigInt(
    priceResp.avg_pri_wei_per_gas ?? priceResp.avgPriWeiPerGas ?? 0,
  );
  const rawMaxFee = base + priority;
  // Floor at 1 gwei — some chains (e.g. BSC) have a 1 gwei minimum validator policy
  // even when the gas price API returns sub-gwei values.
  const maxFeePerGas = rawMaxFee < ONE_GWEI ? ONE_GWEI : rawMaxFee;
  const maxPriorityFeePerGas = priority < ONE_GWEI ? ONE_GWEI : priority;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** Round gas price up to next whole gwei. */
export function alignToGwei(wei: bigint): bigint {
  if (wei === 0n) return ONE_GWEI;
  const remainder = wei % ONE_GWEI;
  if (remainder === 0n) return wei;
  return wei + (ONE_GWEI - remainder);
}

/**
 * Chains that need fees aligned to whole gwei (GateChainEVM, GateLayer).
 * Mirrors wallet_service_mcp constants: gatelayerChainID=10088, gateChainEVMID=86.
 */
const GWEI_ALIGNED_CHAIN_IDS = new Set<number>([10088, 86]);

export function needsGweiAlignment(chainId: number): boolean {
  return GWEI_ALIGNED_CHAIN_IDS.has(chainId);
}
