/**
 * Solana legacy-message transaction builder for native SOL transfers.
 *
 * Wire format follows Solana SDK:
 *   signatures (compact-u16 + 64*N) || message
 *   message = header (3B) || account_keys (compact-u16 + 32*N) || blockhash (32B)
 *           || instructions (compact-u16 + each)
 *   instruction = program_id_index (1B) || accounts (compact-u16 + idx...)
 *                || data (compact-u16 + bytes)
 *
 * Ported from wallet_service_mcp/internal/transfer/solana.go
 */

// ── Base58 (Bitcoin/Solana alphabet) ─────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = BASE58_ALPHABET[rem] + out;
  }
  // leading zero bytes → leading '1'
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function decodeBase58(s: string): Uint8Array {
  const str = s.trim();
  if (!str) throw new Error("empty base58 string");
  const rev = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++)
    rev.set(BASE58_ALPHABET[i]!, i);

  let num = 0n;
  for (const ch of str) {
    const d = rev.get(ch);
    if (d === undefined) throw new Error(`invalid base58 character: ${ch}`);
    num = num * 58n + BigInt(d);
  }
  // bigint → big-endian bytes
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num = num >> 8n;
  }
  // restore leading zeros
  let leadingOnes = 0;
  for (const ch of str) {
    if (ch !== "1") break;
    leadingOnes++;
  }
  const out = new Uint8Array(leadingOnes + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[leadingOnes + i] = bytes[i]!;
  return out;
}

/** Decode a base58 pubkey to exactly 32 bytes (left-padded with zeros if short). */
export function decodeBase58Pubkey(s: string): Uint8Array {
  const raw = decodeBase58(s);
  if (raw.length > 32) {
    throw new Error(`base58 pubkey decoded to ${raw.length} bytes, expected 32`);
  }
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length);
  return out;
}

// ── compact-u16 (shortvec) ───────────────────────────────────────

export function encodeCompactU16(n: number): Uint8Array {
  if (n < 0) throw new Error("compact-u16 negative");
  if (n > 0x3ffff) throw new Error("compact-u16 overflow");
  const buf: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n !== 0) b |= 0x80;
    buf.push(b);
    if (n === 0) break;
  }
  return new Uint8Array(buf);
}

// ── Solana program IDs ───────────────────────────────────────────

export const SYSTEM_PROGRAM_ID = new Uint8Array(32); // all zeros
export const COMPUTE_BUDGET_PROGRAM_ID = decodeBase58Pubkey(
  "ComputeBudget111111111111111111111111111111",
);

const TRANSFER_INSTRUCTION_INDEX = 2; // System program transfer
const SET_COMPUTE_UNIT_PRICE_INDEX = 3;

// ── Legacy message/transaction types & serialization ─────────────

export interface SolCompiledInstruction {
  programIdIndex: number;
  accountKeyIndices: Uint8Array;
  data: Uint8Array;
}

export interface SolMessage {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  accountKeys: Uint8Array[]; // each 32 bytes
  recentBlockhash: Uint8Array; // 32 bytes
  instructions: SolCompiledInstruction[];
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

function u64LE(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let n = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function u32LE(v: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = v & 0xff;
  out[1] = (v >>> 8) & 0xff;
  out[2] = (v >>> 16) & 0xff;
  out[3] = (v >>> 24) & 0xff;
  return out;
}

export function serializeMessage(m: SolMessage): Uint8Array {
  if (m.recentBlockhash.length !== 32)
    throw new Error(`recent_blockhash must be 32 bytes, got ${m.recentBlockhash.length}`);
  for (let i = 0; i < m.accountKeys.length; i++) {
    if (m.accountKeys[i]!.length !== 32)
      throw new Error(`account_keys[${i}] must be 32 bytes, got ${m.accountKeys[i]!.length}`);
  }
  const parts: Uint8Array[] = [];
  parts.push(
    new Uint8Array([
      m.numRequiredSignatures,
      m.numReadonlySigned,
      m.numReadonlyUnsigned,
    ]),
  );
  parts.push(encodeCompactU16(m.accountKeys.length));
  for (const k of m.accountKeys) parts.push(k);
  parts.push(m.recentBlockhash);
  parts.push(encodeCompactU16(m.instructions.length));
  for (const ci of m.instructions) {
    parts.push(new Uint8Array([ci.programIdIndex]));
    parts.push(encodeCompactU16(ci.accountKeyIndices.length));
    parts.push(ci.accountKeyIndices);
    parts.push(encodeCompactU16(ci.data.length));
    parts.push(ci.data);
  }
  return concat(parts);
}

/**
 * Serialize a transaction (signatures + message). For an unsigned tx, pass one
 * 64-zero signature placeholder.
 */
export function serializeTransaction(
  signatures: Uint8Array[],
  message: SolMessage,
): Uint8Array {
  const msgBytes = serializeMessage(message);
  const parts: Uint8Array[] = [];
  parts.push(encodeCompactU16(signatures.length));
  for (const sig of signatures) {
    if (sig.length !== 64) throw new Error(`signature must be 64 bytes, got ${sig.length}`);
    parts.push(sig);
  }
  parts.push(msgBytes);
  return concat(parts);
}

// ── Native SOL transfer builder ──────────────────────────────────

/**
 * Build an unsigned legacy Solana transaction for a native SOL transfer.
 * from/to/blockhash must be 32 bytes each.
 * Returns serialized transaction bytes (one 64-zero signature + message).
 */
export function buildSolanaTransfer(
  from: Uint8Array,
  to: Uint8Array,
  blockhash: Uint8Array,
  lamports: bigint,
  priorityFeeMicroLamports: bigint = 0n,
): Uint8Array {
  if (from.length !== 32) throw new Error(`from pubkey must be 32 bytes, got ${from.length}`);
  if (to.length !== 32) throw new Error(`to pubkey must be 32 bytes, got ${to.length}`);
  if (blockhash.length !== 32) throw new Error(`blockhash must be 32 bytes, got ${blockhash.length}`);

  const accountKeys: Uint8Array[] = [from, to, SYSTEM_PROGRAM_ID];
  let numReadonlyUnsigned = 1; // system program
  const instructions: SolCompiledInstruction[] = [];

  if (priorityFeeMicroLamports > 0n) {
    accountKeys.push(COMPUTE_BUDGET_PROGRAM_ID);
    numReadonlyUnsigned = 2;
    const prioData = new Uint8Array(1 + 8);
    prioData[0] = SET_COMPUTE_UNIT_PRICE_INDEX;
    prioData.set(u64LE(priorityFeeMicroLamports), 1);
    instructions.push({
      programIdIndex: 3,
      accountKeyIndices: new Uint8Array(0),
      data: prioData,
    });
  }

  // System transfer instruction: program_id_index=2, accounts=[0,1]
  const data = new Uint8Array(4 + 8);
  data.set(u32LE(TRANSFER_INSTRUCTION_INDEX), 0);
  data.set(u64LE(lamports), 4);
  instructions.push({
    programIdIndex: 2,
    accountKeyIndices: new Uint8Array([0, 1]),
    data,
  });

  const msg: SolMessage = {
    numRequiredSignatures: 1,
    numReadonlySigned: 0,
    numReadonlyUnsigned,
    accountKeys,
    recentBlockhash: blockhash,
    instructions,
  };

  const sigPlaceholder = new Uint8Array(64);
  return serializeTransaction([sigPlaceholder], msg);
}

/** Build native SOL transfer from base58 addresses/blockhash. */
export function buildSolanaTransferFromBase58(
  fromBase58: string,
  toBase58: string,
  blockhashBase58: string,
  lamports: bigint,
  priorityFeeMicroLamports: bigint = 0n,
): Uint8Array {
  const from = decodeBase58Pubkey(fromBase58);
  const to = decodeBase58Pubkey(toBase58);
  const bh = decodeBase58(blockhashBase58);
  if (bh.length !== 32)
    throw new Error(`blockhash must decode to 32 bytes, got ${bh.length}`);
  return buildSolanaTransfer(from, to, bh, lamports, priorityFeeMicroLamports);
}
