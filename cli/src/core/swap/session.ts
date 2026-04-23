/**
 * In-memory staged swap session store. MCP uses Redis; CLI is single-process
 * so a Map + TTL is sufficient.
 *
 * Session lifecycle: prepare → checkin_preview → sign_approve (if needed)
 *                  → sign_swap → submit (deletes session)
 *
 * Ported from wallet_service_mcp/internal/tool/swap_staged.go (swapRedisSessionStore).
 */

import type { BuildV3Resp } from "../api-client.js";

export const SWAP_SESSION_TTL_MS = 5 * 60 * 1000; // 5 min EVM
export const SWAP_SESSION_SOLANA_TTL_MS = 45 * 1000; // 45 s Solana
export const SOLANA_CHAIN_ID = 501;

export interface SwapQuoteReq {
  chain_id_in: number;
  chain_id_out: number;
  token_in: string;
  token_out: string;
  amount: string;
  slippage: number;
  slippage_type: number;
  swap_type: number;
  native_in: number;
  native_out: number;
  user_wallet: string;
  from_wallet: string;
  to_wallet: string;
  extra_data?: Record<string, unknown>;
}

export interface SwapQuoteSnapshot {
  amount_in?: string;
  amount_out?: string;
  from_token?: string;
  to_token?: string;
  slippage: number;
  route_path: string[];
}

export interface SwapPrepareApproveContext {
  approve_address: string;
  approve_amount: string;
  from_token_contract: string;
  from_token_decimal: number;
  amount_in: string;
  approve_gas_limit: number;
}

export interface SwapSessionState {
  session_id: string;
  account_id: string;
  mcp_token: string;
  chain_id_in: number;
  chain_id_out: number;
  user_wallet: string;
  to_wallet: string;
  native_in: number;
  native_out: number;
  slippage: number;
  is_solana: boolean;
  need_approve: boolean;
  quote_req: SwapQuoteReq;
  quote_raw: Record<string, unknown>;
  quote_snapshot: SwapQuoteSnapshot;
  build_resp: BuildV3Resp;
  pending_swap_sign_payload: string;
  approve_context?: SwapPrepareApproveContext;
  approve_nonce?: bigint;
  nonce_override?: bigint;
  signed_approve_tx?: string;
  approve_signed?: boolean;
  approve_check_passed?: boolean;
  signed_swap_tx?: string;
  swap_signed?: boolean;
  swap_check_passed?: boolean;
  last_tx_hash?: string;
  last_tx_order_id?: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

class SwapSessionStore {
  private readonly store = new Map<string, SwapSessionState>();

  touch(session: SwapSessionState): void {
    const ttl = session.is_solana ? SWAP_SESSION_SOLANA_TTL_MS : SWAP_SESSION_TTL_MS;
    session.expires_at = Date.now() + ttl;
    session.updated_at = Date.now();
    this.store.set(session.session_id, session);
  }

  get(sessionId: string): SwapSessionState | undefined {
    const sess = this.store.get(sessionId.trim());
    if (!sess) return undefined;
    if (Date.now() > sess.expires_at) {
      this.store.delete(sessionId.trim());
      return undefined;
    }
    return sess;
  }

  delete(sessionId: string): void {
    this.store.delete(sessionId.trim());
  }
}

export const stagedSwapSessions = new SwapSessionStore();

/** Simple UUID4 (good enough for session IDs — not crypto). */
export function newSessionId(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
