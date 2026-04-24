/**
 * SPL Token transfer builder, including Associated Token Account (ATA) derivation.
 *
 * Ported from wallet_service_mcp/internal/transfer/solana.go (SPL portions).
 */

import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  decodeBase58,
  decodeBase58Pubkey,
  encodeCompactU16,
  serializeTransaction,
  type SolCompiledInstruction,
  type SolMessage,
} from "./solana.js";

const SPL_TOKEN_PROGRAM_ID = decodeBase58Pubkey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM_ID = decodeBase58Pubkey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

const SET_COMPUTE_UNIT_PRICE_INDEX = 3;
const SPL_TRANSFER_INSTRUCTION_INDEX = 3;
const ATA_CREATE_IDEMPOTENT_INDEX = 1;

function u64LE(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let n = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
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

/**
 * Solana PDA must not be a valid curve point. Returns true if the 32 bytes
 * decode as a valid compressed Ed25519 point (meaning it's NOT a valid PDA).
 */
function isOnCurve(point: Uint8Array): boolean {
  try {
    // v2 API: Point.fromBytes throws if not on curve
    (ed25519 as unknown as { Point: { fromBytes: (b: Uint8Array) => unknown } })
      .Point.fromBytes(point);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/**
 * Derive a Program Derived Address (PDA). Tries bump 255 → 0 and returns the
 * first hash that's NOT on the curve.
 */
function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): { address: Uint8Array; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const hasher = createHash("sha256");
    for (const s of seeds) hasher.update(s);
    hasher.update(new Uint8Array([bump]));
    hasher.update(programId);
    hasher.update(PDA_MARKER);
    const hash = hasher.digest();
    const addr = new Uint8Array(hash);
    if (!isOnCurve(addr)) {
      return { address: addr, bump };
    }
  }
  throw new Error("unable to find a viable program address bump");
}

/** Derive Associated Token Account for (owner, mint). */
export function getAssociatedTokenAddress(
  owner: Uint8Array,
  mint: Uint8Array,
): Uint8Array {
  const seeds = [owner, SPL_TOKEN_PROGRAM_ID, mint];
  return findProgramAddress(seeds, ASSOCIATED_TOKEN_PROGRAM_ID).address;
}

/**
 * Build SPL transfer with CreateAssociatedTokenAccountIdempotent prefix
 * so the recipient's ATA is created if missing (fixes "invalid account data"
 * on first-time token transfers).
 *
 * account_keys: [owner/payer, to, sourceATA, destATA, mint, system, token, ata]
 *               (+ compute_budget when priorityFee > 0)
 * Indices:      [     0     , 1 ,     2    ,    3   ,  4  ,   5  ,   6  ,  7  ]
 */
export function buildSolanaSPLTransferWithCreateDest(args: {
  sourceATA: Uint8Array;
  destATA: Uint8Array;
  owner: Uint8Array;
  to: Uint8Array;
  mint: Uint8Array;
  blockhash: Uint8Array;
  amount: bigint;
  priorityFeeMicroLamports?: bigint;
}): Uint8Array {
  const {
    sourceATA,
    destATA,
    owner,
    to,
    mint,
    blockhash,
    amount,
    priorityFeeMicroLamports = 0n,
  } = args;
  for (const [name, v] of [
    ["sourceATA", sourceATA],
    ["destATA", destATA],
    ["owner", owner],
    ["to", to],
    ["mint", mint],
    ["blockhash", blockhash],
  ] as const) {
    if (v.length !== 32) throw new Error(`${name} must be 32 bytes, got ${v.length}`);
  }

  const accountKeys: Uint8Array[] = [
    owner,
    to,
    sourceATA,
    destATA,
    mint,
    SYSTEM_PROGRAM_ID,
    SPL_TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ];
  let numReadonlyUnsigned = 4; // mint, system, token, ata
  const instructions: SolCompiledInstruction[] = [];

  // CreateAssociatedTokenAccountIdempotent:
  //   payer=0, ata=3, owner=1, mint=4, system=5, token=6. program 7. data: [1]
  instructions.push({
    programIdIndex: 7,
    accountKeyIndices: new Uint8Array([0, 3, 1, 4, 5, 6]),
    data: new Uint8Array([ATA_CREATE_IDEMPOTENT_INDEX]),
  });

  if (priorityFeeMicroLamports > 0n) {
    accountKeys.push(COMPUTE_BUDGET_PROGRAM_ID);
    numReadonlyUnsigned = 5;
    const prioData = new Uint8Array(1 + 8);
    prioData[0] = SET_COMPUTE_UNIT_PRICE_INDEX;
    prioData.set(u64LE(priorityFeeMicroLamports), 1);
    instructions.push({
      programIdIndex: 8,
      accountKeyIndices: new Uint8Array(0),
      data: prioData,
    });
  }

  // SPL Transfer: program 6, accounts [source=2, dest=3, owner=0]
  const data = new Uint8Array(1 + 8);
  data[0] = SPL_TRANSFER_INSTRUCTION_INDEX;
  data.set(u64LE(amount), 1);
  instructions.push({
    programIdIndex: 6,
    accountKeyIndices: new Uint8Array([2, 3, 0]),
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

/** Build SPL transfer from base58 addresses and mint; fetches blockhash via callback. */
export async function buildSolanaSPLTransferFromBase58(
  fromBase58: string,
  toBase58: string,
  mintBase58: string,
  amount: bigint,
  getBlockhash: () => Promise<string>,
  priorityFeeMicroLamports: bigint = 0n,
): Promise<Uint8Array> {
  const owner = decodeBase58Pubkey(fromBase58);
  const to = decodeBase58Pubkey(toBase58);
  const mint = decodeBase58Pubkey(mintBase58);
  const sourceATA = getAssociatedTokenAddress(owner, mint);
  const destATA = getAssociatedTokenAddress(to, mint);
  const bhStr = await getBlockhash();
  const bh = decodeBase58(bhStr);
  if (bh.length !== 32)
    throw new Error(`blockhash must be 32 bytes, got ${bh.length}`);
  return buildSolanaSPLTransferWithCreateDest({
    sourceATA,
    destATA,
    owner,
    to,
    mint,
    blockhash: bh,
    amount,
    priorityFeeMicroLamports,
  });
}
// encodeCompactU16 is re-exported for downstream consumers via solana.ts
export { encodeCompactU16 };
