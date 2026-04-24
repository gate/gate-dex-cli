/**
 * Staged swap flow (prepare / checkin_preview / sign_approve / sign_swap / submit).
 *
 * Replaces MCP tools:
 *   dex_tx_swap_prepare
 *   dex_tx_swap_checkin_preview
 *   dex_tx_swap_sign_approve
 *   dex_tx_swap_sign_swap
 *   dex_tx_swap_submit
 *
 * Ported from wallet_service_mcp/internal/tool/swap_staged.go.
 * Session state is kept in-memory (CLI is single-process) instead of Redis.
 */

import {
  alignToGwei,
  buildEIP1559UnsignedHex,
  needsGweiAlignment,
  resolveEIP1559Fee,
} from "../transfer/eip1559.js";
import {
  buildERC20ApproveData,
  parseAmountWithPrecisionCheck,
} from "../transfer/erc20.js";
import { encodeBase58 } from "../transfer/solana.js";
import {
  createSwapApiClient,
  type BuildV3Resp,
} from "../api-client.js";
import {
  createGatewayApiClient,
  type GatewayApiClient,
  gatewayChainConfig,
  gatewayEvmGasPrice,
  gatewayGetEvmNonce,
  gatewaySolGasPrice,
} from "../gateway-client.js";
import {
  newSessionId,
  SOLANA_CHAIN_ID,
  stagedSwapSessions,
  type SwapPrepareApproveContext,
  type SwapQuoteReq,
  type SwapQuoteSnapshot,
  type SwapSessionState,
} from "./session.js";

const DEFAULT_ERC20_GAS_LIMIT = 100000;

// ── Helpers ──────────────────────────────────────────────────────

function resolveChainNameByID(
  innerChainConfig: { network?: Record<string, { networkChainID?: string | number; networkKey?: string }> },
  chainId: number,
): string {
  const target = String(chainId);
  const net = innerChainConfig.network ?? {};
  for (const entry of Object.values(net)) {
    if (String(entry.networkChainID ?? "") === target) {
      return String(entry.networkKey ?? "").toLowerCase();
    }
  }
  throw new Error(`chain name not found for chainId ${chainId}`);
}

async function getChainName(
  gw: GatewayApiClient,
  chainId: number,
): Promise<string> {
  const cfg = (await gatewayChainConfig(gw)) as {
    network?: Record<string, { networkChainID?: string | number; networkKey?: string }>;
  };
  return resolveChainNameByID(cfg, chainId);
}

/** base64 → base58 (for Solana swap unsigned tx coming from build service). */
function base64ToBase58(b64: string): string {
  const raw = Buffer.from(b64, "base64");
  if (raw.length === 0) throw new Error("empty base64 data");
  return encodeBase58(new Uint8Array(raw));
}

function isGatelayerGateChainSwap(chainIdIn: number, chainIdOut: number): boolean {
  const gatelayer = 10088;
  const gateChain = 86;
  return (
    (chainIdIn === gatelayer && chainIdOut === gateChain) ||
    (chainIdIn === gateChain && chainIdOut === gatelayer)
  );
}

function cloneJSON<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ── Quote / build parsing ────────────────────────────────────────

interface QuoteFields {
  need_approved?: number;
  approve_address?: string;
  approve_amount?: string;
  amount_in?: string;
  amount_out?: string;
  from_token?: {
    token_symbol?: string;
    decimal?: number;
    chain_id?: number;
    token_contract_address?: string;
  };
  to_token?: { token_symbol?: string };
  routes?: Array<{ dex_name?: string }>;
}

function parseSwapQuote(
  raw: Record<string, unknown>,
  slippage: number,
): { fields: QuoteFields; snapshot: SwapQuoteSnapshot } {
  const fields = raw as QuoteFields;
  const route_path = (fields.routes ?? [])
    .map((r) => (r.dex_name ?? "").trim())
    .filter(Boolean);
  return {
    fields,
    snapshot: {
      amount_in: fields.amount_in,
      amount_out: fields.amount_out,
      from_token: fields.from_token?.token_symbol,
      to_token: fields.to_token?.token_symbol,
      slippage,
      route_path,
    },
  };
}

interface UnsignedTxFields {
  chainId?: number;
  to?: string;
  data?: string;
  value?: string | number;
  gasLimit?: string | number;
  approveGasLimit?: string | number;
}

interface BuildExtraDataParsed {
  srcChainId?: number;
  from?: string;
}

function toNumber(v: string | number | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const s = v.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) return Number(BigInt(s));
  return Number(s);
}

function toBigInt(v: string | number | undefined): bigint {
  if (v == null) return 0n;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  const s = v.trim();
  if (s === "") return 0n;
  if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
  return BigInt(s);
}

function extractUnsignedTx(resp: BuildV3Resp): UnsignedTxFields {
  const raw = resp.unsignedTx;
  if (!raw) throw new Error("build response has no unsignedTx");
  if (typeof raw === "string") return JSON.parse(raw) as UnsignedTxFields;
  return raw as UnsignedTxFields;
}

// ── Step 1: prepare ──────────────────────────────────────────────

export interface SwapPrepareInput {
  chain_id_in: number;
  chain_id_out: number;
  token_in: string;
  token_out: string;
  amount: string;
  slippage: number;
  native_in: number;
  native_out: number;
  user_wallet: string;
  to_wallet?: string;
  account_id: string;
  mcp_token: string;
}

export interface SwapPrepareResult {
  swap_session_id: string;
  need_approved: boolean;
  chain: "EVM" | "SOL";
  quote_info: SwapQuoteSnapshot;
  status: "prepared";
  message: string;
  expires_at: string;
}

export async function swapPrepare(
  input: SwapPrepareInput,
): Promise<SwapPrepareResult> {
  const userWallet = input.user_wallet.trim();
  const toWallet = (input.to_wallet ?? userWallet).trim();
  const accountId = input.account_id.trim();

  const tokenIn = input.native_in === 1 ? "-" : input.token_in;
  const tokenOut = input.native_out === 1 ? "-" : input.token_out;

  const quoteReq: SwapQuoteReq = {
    chain_id_in: input.chain_id_in,
    chain_id_out: input.chain_id_out,
    token_in: tokenIn,
    token_out: tokenOut,
    amount: input.amount,
    slippage: input.slippage,
    slippage_type: 2,
    swap_type: 2,
    user_wallet: userWallet,
    from_wallet: userWallet,
    to_wallet: toWallet,
    native_in: input.native_in,
    native_out: input.native_out,
    extra_data: { is_multi: true },
  };

  const swap = createSwapApiClient();
  const quoteRaw = await swap.quote(quoteReq);

  const { fields: quoteFields, snapshot } = parseSwapQuote(quoteRaw, input.slippage);
  const isSolana = quoteReq.chain_id_in === SOLANA_CHAIN_ID;

  // Build execution (build_v3)
  const gw = createGatewayApiClient(input.mcp_token);
  let priorityFeePerCu: string | undefined;
  if (isSolana) {
    try {
      const priceResp = await gatewaySolGasPrice(gw);
      const fee = String(priceResp.avg_microlp_per_cu ?? "");
      if (fee && fee !== "0") priorityFeePerCu = fee;
    } catch {
      // priority fee optional
    }
  }

  let projectId = 13;
  if (quoteReq.chain_id_in !== quoteReq.chain_id_out) projectId = 10;
  if (isGatelayerGateChainSwap(quoteReq.chain_id_in, quoteReq.chain_id_out)) {
    projectId = 1;
  }

  const extraData: Record<string, unknown> = { accountId };
  if (priorityFeePerCu) extraData.priorityFeePerCu = priorityFeePerCu;

  const buildResp = await swap.build({
    projectId,
    params: {
      from: userWallet,
      to: toWallet,
      routes: cloneJSON(quoteRaw),
    },
    extraData,
    userAgent: "gate-dex-cli",
    source: "cli",
  });

  // Approve context (EVM only, when need_approved=2)
  let approveCtx: SwapPrepareApproveContext | undefined;
  const needApprove = quoteFields.need_approved === 2 && !isSolana;
  if (needApprove) {
    const utx = extractUnsignedTx(buildResp);
    let approveGasLimit = toNumber(utx.approveGasLimit);
    if (!approveGasLimit) approveGasLimit = DEFAULT_ERC20_GAS_LIMIT;
    approveCtx = {
      approve_address: quoteFields.approve_address ?? "",
      approve_amount: quoteFields.approve_amount ?? "",
      from_token_contract: quoteFields.from_token?.token_contract_address ?? "",
      from_token_decimal: quoteFields.from_token?.decimal ?? 0,
      amount_in: quoteFields.amount_in ?? "",
      approve_gas_limit: approveGasLimit,
    };
  }

  const session: SwapSessionState = {
    session_id: newSessionId(),
    account_id: accountId,
    mcp_token: input.mcp_token,
    chain_id_in: quoteReq.chain_id_in,
    chain_id_out: quoteReq.chain_id_out,
    user_wallet: userWallet,
    to_wallet: toWallet,
    native_in: quoteReq.native_in,
    native_out: quoteReq.native_out,
    slippage: input.slippage,
    is_solana: isSolana,
    need_approve: needApprove,
    quote_req: quoteReq,
    quote_raw: quoteRaw,
    quote_snapshot: snapshot,
    build_resp: buildResp,
    pending_swap_sign_payload: "",
    approve_context: approveCtx,
    created_at: Date.now(),
    updated_at: Date.now(),
    expires_at: 0,
  };
  stagedSwapSessions.touch(session);

  let message: string;
  if (isSolana) {
    message = "Swap session prepared. For Solana, the final signable tx is generated fresh during swap_sign_swap.";
  } else if (needApprove) {
    message = "Swap session prepared. Sign approve first, then sign swap, then submit.";
  } else {
    message = "Swap session prepared. Sign swap next, then submit.";
  }

  return {
    swap_session_id: session.session_id,
    need_approved: needApprove,
    chain: isSolana ? "SOL" : "EVM",
    quote_info: snapshot,
    status: "prepared",
    message,
    expires_at: new Date(session.expires_at).toISOString(),
  };
}

// ── Rebuild (used after approve signing / solana sign stage) ─────

async function rebuildBuildResp(session: SwapSessionState): Promise<BuildV3Resp> {
  const swap = createSwapApiClient();
  const gw = createGatewayApiClient(session.mcp_token);

  let priorityFeePerCu: string | undefined;
  if (session.is_solana) {
    try {
      const priceResp = await gatewaySolGasPrice(gw);
      const fee = String(priceResp.avg_microlp_per_cu ?? "");
      if (fee && fee !== "0") priorityFeePerCu = fee;
    } catch {
      // priority fee optional
    }
  }
  let projectId = 13;
  if (session.chain_id_in !== session.chain_id_out) projectId = 10;
  if (isGatelayerGateChainSwap(session.chain_id_in, session.chain_id_out)) {
    projectId = 1;
  }
  const extraData: Record<string, unknown> = { accountId: session.account_id };
  if (priorityFeePerCu) extraData.priorityFeePerCu = priorityFeePerCu;

  const buildResp = await swap.build({
    projectId,
    params: {
      from: session.user_wallet,
      to: session.to_wallet,
      routes: cloneJSON(session.quote_raw),
    },
    extraData,
    userAgent: "gate-dex-cli",
    source: "cli",
  });
  session.build_resp = buildResp;
  return buildResp;
}

// ── Helper: enrich build v3 with EIP-1559 (EVM swap / solana passthrough) ──

async function enrichBuildWithEIP1559(
  gw: GatewayApiClient,
  resp: BuildV3Resp,
  fallbackFrom: string,
  nonceOverride: bigint | undefined,
): Promise<string> {
  const txFields = extractUnsignedTx(resp);
  let chainId = txFields.chainId ?? 0;
  let fromAddr = fallbackFrom;
  if (resp.extraData) {
    try {
      const extra = JSON.parse(resp.extraData) as BuildExtraDataParsed;
      if (extra.srcChainId && extra.srcChainId > 0) chainId = extra.srcChainId;
      if (extra.from) fromAddr = extra.from;
    } catch {
      // extraData is optional
    }
  }
  if (chainId <= 0) throw new Error(`invalid chainId: ${chainId}`);

  const chainName = await getChainName(gw, chainId);

  let nonce: bigint;
  if (nonceOverride != null) {
    nonce = nonceOverride;
  } else {
    nonce = await gatewayGetEvmNonce(gw, chainName, fromAddr);
  }

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  try {
    const priceResp = await gatewayEvmGasPrice(gw, chainName);
    ({ maxFeePerGas, maxPriorityFeePerGas } = resolveEIP1559Fee(priceResp));
  } catch {
    ({ maxFeePerGas, maxPriorityFeePerGas } = resolveEIP1559Fee(null));
  }
  if (needsGweiAlignment(chainId)) {
    maxFeePerGas = alignToGwei(maxFeePerGas);
    maxPriorityFeePerGas = alignToGwei(maxPriorityFeePerGas);
  }

  const value = toBigInt(txFields.value);
  let gasLimit = toNumber(txFields.gasLimit);
  if (!gasLimit) gasLimit = DEFAULT_ERC20_GAS_LIMIT;

  return buildEIP1559UnsignedHex({
    chainId,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit,
    to: txFields.to ?? "",
    value,
    dataHex: txFields.data ?? "0x",
  });
}

async function buildSwapApproveUnsigned(
  session: SwapSessionState,
): Promise<{ unsigned_hex: string; nonce: bigint }> {
  if (!session.approve_context) {
    throw new Error("swap session approve context is missing");
  }
  const gw = createGatewayApiClient(session.mcp_token);
  const chainName = await getChainName(gw, session.chain_id_in);

  const ctx = session.approve_context;
  // Resolve approve amount (use approve_amount if non-zero, else parse amount_in * 10^decimals)
  let approveAmount: bigint;
  if (ctx.approve_amount && ctx.approve_amount !== "0") {
    approveAmount = BigInt(ctx.approve_amount);
  } else if (ctx.amount_in && ctx.from_token_decimal > 0) {
    const parsed = parseAmountWithPrecisionCheck(
      ctx.amount_in,
      ctx.from_token_decimal,
      "approve",
    );
    approveAmount = parsed.amount;
  } else {
    // max uint256
    approveAmount = BigInt(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    );
  }

  const calldata = buildERC20ApproveData(ctx.approve_address, approveAmount);
  const nonce = await gatewayGetEvmNonce(gw, chainName, session.user_wallet);

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  try {
    const priceResp = await gatewayEvmGasPrice(gw, chainName);
    ({ maxFeePerGas, maxPriorityFeePerGas } = resolveEIP1559Fee(priceResp));
  } catch {
    ({ maxFeePerGas, maxPriorityFeePerGas } = resolveEIP1559Fee(null));
  }
  if (needsGweiAlignment(session.chain_id_in)) {
    maxFeePerGas = alignToGwei(maxFeePerGas);
    maxPriorityFeePerGas = alignToGwei(maxPriorityFeePerGas);
  }

  const unsignedHex = buildEIP1559UnsignedHex({
    chainId: session.chain_id_in,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit: ctx.approve_gas_limit || DEFAULT_ERC20_GAS_LIMIT,
    to: ctx.from_token_contract,
    value: 0n,
    dataHex: calldata,
  });

  return { unsigned_hex: unsignedHex, nonce };
}

async function buildSwapSignPayload(session: SwapSessionState): Promise<string> {
  if (!session.build_resp) throw new Error("swap session build context is missing");
  const pending = session.pending_swap_sign_payload.trim();
  if (pending) return pending;
  if (session.is_solana) {
    const utx = extractUnsignedTx(session.build_resp);
    if (!utx.data) throw new Error("build response missing unsignedTx.data for Solana");
    return base64ToBase58(utx.data);
  }
  const gw = createGatewayApiClient(session.mcp_token);
  return enrichBuildWithEIP1559(
    gw,
    session.build_resp,
    session.user_wallet,
    session.nonce_override,
  );
}

// ── Step 2: checkin preview ──────────────────────────────────────

export interface SwapCheckinPreviewInput {
  swap_session_id: string;
  stage: "approve" | "swap";
}

export interface SwapCheckinPreviewResult {
  chain: string;
  chain_category: "ethereum" | "solana";
  user_wallet: string;
  checkin_path: "/api/v1/tx/checkin";
  checkin_message: string;
  unsigned_payload: string;
}

function buildCheckinMessage(unsignedPayload: string, chainCategory: string): string {
  return JSON.stringify({
    tx: unsignedPayload,
    category: chainCategory,
    enc: "",
    network: { chainId: 0 },
    type: "",
  });
}

export async function swapCheckinPreview(
  input: SwapCheckinPreviewInput,
): Promise<SwapCheckinPreviewResult> {
  const session = stagedSwapSessions.get(input.swap_session_id);
  if (!session) {
    throw new Error(
      "swap session not found or expired; please call swap_prepare again",
    );
  }
  const stage = input.stage;

  if (stage === "approve" && session.is_solana) {
    throw new Error("approve check-in preview is only available for EVM swap sessions");
  }
  if (stage === "approve" && !session.need_approve) {
    throw new Error("current swap session does not require approve");
  }
  if (stage === "swap" && session.need_approve && !session.approve_signed) {
    throw new Error("approve must be signed before requesting swap check-in preview");
  }

  // Solana swap stage: rebuild to get fresh blockhash
  if (stage === "swap" && session.is_solana) {
    await rebuildBuildResp(session);
    session.pending_swap_sign_payload = "";
  }
  if (stage === "swap") {
    session.pending_swap_sign_payload = "";
  }

  let payload: string;
  if (stage === "approve") {
    payload = (await buildSwapApproveUnsigned(session)).unsigned_hex;
  } else {
    payload = await buildSwapSignPayload(session);
  }
  if (stage === "swap") {
    session.pending_swap_sign_payload = payload;
  }

  const gw = createGatewayApiClient(session.mcp_token);
  let chainName: string;
  try {
    chainName = await getChainName(gw, session.chain_id_in);
  } catch {
    chainName = session.is_solana ? "SOL" : "EVM";
  }

  const chainCategory: "ethereum" | "solana" = chainName.toUpperCase() === "SOL" ? "solana" : "ethereum";
  stagedSwapSessions.touch(session);
  return {
    chain: chainName,
    chain_category: chainCategory,
    user_wallet: session.user_wallet,
    checkin_path: "/api/v1/tx/checkin",
    checkin_message: buildCheckinMessage(payload, chainCategory),
    unsigned_payload: payload,
  };
}

// ── Step 3: sign approve (EVM only) ──────────────────────────────

export interface SwapSignApproveInput {
  swap_session_id: string;
  /** checkin_token returned by GV /api/v1/tx/checkin. */
  checkin_token: string;
  /** Caller supplies a signer since BW sign needs upstream access_token. */
  signTransaction: (opts: {
    rawTx: string;
    chain: "EVM" | "SOL";
    checkinToken: string;
  }) => Promise<{ signedTransaction: string }>;
}

export interface SwapSignResult {
  swap_session_id: string;
  stage: "approve" | "swap";
  status: "signed";
  message: string;
}

function ensureHexPrefix(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s : "0x" + s;
}

function looksLikeEvmHex(s: string): boolean {
  const raw = s.replace(/^0x/i, "");
  return raw.length > 0 && /^[0-9a-fA-F]+$/.test(raw);
}

export async function swapSignApprove(
  input: SwapSignApproveInput,
): Promise<SwapSignResult> {
  const session = stagedSwapSessions.get(input.swap_session_id);
  if (!session) {
    throw new Error("swap session not found or expired; please call swap_prepare again");
  }
  if (session.is_solana) {
    throw new Error("approve signing is only available for EVM swap sessions");
  }
  if (!session.need_approve) {
    throw new Error("current swap session does not require approve");
  }
  if (session.approve_signed) {
    return {
      swap_session_id: session.session_id,
      stage: "approve",
      status: "signed",
      message: "Approve transaction already signed for this swap session.",
    };
  }

  const { unsigned_hex: unsignedApproveHex, nonce } =
    await buildSwapApproveUnsigned(session);

  const signResp = await input.signTransaction({
    rawTx: unsignedApproveHex,
    chain: "EVM",
    checkinToken: input.checkin_token,
  });

  let signed = signResp.signedTransaction;
  if (looksLikeEvmHex(signed)) signed = ensureHexPrefix(signed);

  session.approve_nonce = nonce;
  session.nonce_override = nonce + 1n;
  session.signed_approve_tx = signed;
  session.approve_signed = true;
  session.approve_check_passed = true;

  // Rebuild swap tx with new nonce
  await rebuildBuildResp(session);
  stagedSwapSessions.touch(session);

  return {
    swap_session_id: session.session_id,
    stage: "approve",
    status: "signed",
    message: "Approve transaction signed and swap session updated.",
  };
}

// ── Step 4: sign swap ────────────────────────────────────────────

export interface SwapSignSwapInput {
  swap_session_id: string;
  checkin_token: string;
  signTransaction: SwapSignApproveInput["signTransaction"];
}

export async function swapSignSwap(
  input: SwapSignSwapInput,
): Promise<SwapSignResult> {
  const session = stagedSwapSessions.get(input.swap_session_id);
  if (!session) {
    throw new Error("swap session not found or expired; please call swap_prepare again");
  }
  if (session.need_approve && !session.approve_signed) {
    throw new Error("approve must be signed before swap signing");
  }
  if (session.is_solana && !session.pending_swap_sign_payload.trim()) {
    throw new Error(
      "solana swap signing requires a fresh swap check-in preview; please call swap_checkin_preview with stage='swap' again",
    );
  }

  const rawTxForSign = await buildSwapSignPayload(session);
  const signResp = await input.signTransaction({
    rawTx: rawTxForSign,
    chain: session.is_solana ? "SOL" : "EVM",
    checkinToken: input.checkin_token,
  });

  let signed = signResp.signedTransaction;
  if (!session.is_solana && looksLikeEvmHex(signed)) signed = ensureHexPrefix(signed);

  session.signed_swap_tx = signed;
  session.swap_signed = true;
  session.swap_check_passed = true;
  session.pending_swap_sign_payload = "";
  stagedSwapSessions.touch(session);

  return {
    swap_session_id: session.session_id,
    stage: "swap",
    status: "signed",
    message: "Swap transaction signed. Call swap_submit immediately to submit.",
  };
}

// ── Step 5: submit ───────────────────────────────────────────────

export interface SwapSubmitInput {
  swap_session_id: string;
}

export interface SwapSubmitResult {
  swap_session_id: string;
  tx_hash: string;
  tx_order_id: string;
  status: "submitted";
  message: string;
}

export async function swapSubmit(
  input: SwapSubmitInput,
): Promise<SwapSubmitResult> {
  const session = stagedSwapSessions.get(input.swap_session_id);
  if (!session) {
    throw new Error("swap session not found or expired; please call swap_prepare again");
  }
  if (!session.build_resp) {
    throw new Error("swap session build context is missing; please re-prepare");
  }
  if (!session.signed_swap_tx) {
    throw new Error("swap transaction is not signed yet");
  }
  if (session.need_approve && !session.signed_approve_tx) {
    throw new Error("approve transaction is required but not signed yet");
  }
  if (session.is_solana && Date.now() > session.expires_at) {
    stagedSwapSessions.delete(session.session_id);
    throw new Error(
      "solana swap session expired before submit; please call swap_prepare again",
    );
  }

  const build = session.build_resp;
  const submitReq: Record<string, unknown> = {
    signature: build.signature ?? "",
    unsignedTx: build.unsignedTx,
    unsignedTxString: build.unsignedTxString ?? "",
    extraData: build.extraData ?? "",
    projectId: build.projectId ?? 0,
    ts: build.ts ?? 0,
    signedTxString: JSON.stringify([session.signed_swap_tx]),
  };
  if (session.signed_approve_tx) {
    submitReq.signedApproveTxString = JSON.stringify([session.signed_approve_tx]);
  }

  const swap = createSwapApiClient();
  const submitResp = (await swap.submit(submitReq)) as {
    txHash?: string;
    txOrderId?: string;
    tx_hash?: string;
    tx_order_id?: string;
  };
  const txHash = submitResp.txHash ?? submitResp.tx_hash ?? "";
  const txOrderId = submitResp.txOrderId ?? submitResp.tx_order_id ?? "";

  session.last_tx_hash = txHash;
  session.last_tx_order_id = txOrderId;
  stagedSwapSessions.delete(session.session_id);

  return {
    swap_session_id: session.session_id,
    tx_hash: txHash,
    tx_order_id: txOrderId,
    status: "submitted",
    message: "Transaction submitted. Poll swap detail with tx_order_id every 5s.",
  };
}
