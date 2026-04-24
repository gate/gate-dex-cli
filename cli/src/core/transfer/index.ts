/**
 * Public transfer API — replaces MCP tools `dex_tx_transfer_preview`
 * and `dex_tx_get_sol_unsigned`.
 *
 * Supports:
 *   EVM native coin transfer (ETH, BNB, MATIC, ...)
 *   EVM ERC20 transfer (USDT or any token via contract + decimals)
 *   Solana native SOL transfer
 *   Solana SPL token transfer (with idempotent ATA creation)
 */

import {
  alignToGwei,
  buildEIP1559UnsignedHex,
  needsGweiAlignment,
  resolveEIP1559Fee,
} from "./eip1559.js";
import {
  buildERC20TransferData,
  getTokenPrecisionInfo,
  getUSDTContract,
  getUSDTDecimals,
  parseAmountWithPrecisionCheck,
  SOLANA_NATIVE_DECIMALS,
} from "./erc20.js";
import {
  buildSolanaTransferFromBase58,
  encodeBase58,
} from "./solana.js";
import { buildSolanaSPLTransferFromBase58 } from "./solana-spl.js";
import {
  createGatewayApiClient,
  type GatewayApiClient,
  gatewayChainConfig,
  gatewayEvmGasPrice,
  gatewayEvmGasLimit,
  gatewayGetEvmNonce,
  gatewayGetSolanaBlockhash,
  gatewayGetERC20Decimals,
} from "../gateway-client.js";

// ── Helper: gas price + gas limit ────────────────────────────────

async function estimateEvmGas(
  gw: GatewayApiClient,
  chainKey: string,
  from: string,
  to: string,
  dataHex: string,
  valueDec: string,
  fallbackLimit: number,
): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: number;
}> {
  let gasLimit = fallbackLimit;
  try {
    const resp = await gatewayEvmGasLimit(gw, {
      chain: chainKey,
      from,
      to,
      data: dataHex,
      value: valueDec,
    });
    const used = BigInt(resp.gas_used ?? 0);
    const factor = resp.gas_base_limit_factor ?? 1;
    if (used > 0n) {
      gasLimit = Math.ceil(Number(used) * factor);
    }
  } catch {
    // keep fallback limit
  }

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  try {
    const priceResp = await gatewayEvmGasPrice(gw, chainKey);
    ({ maxFeePerGas, maxPriorityFeePerGas } = resolveEIP1559Fee(priceResp));
  } catch {
    ({ maxFeePerGas, maxPriorityFeePerGas } = resolveEIP1559Fee(null));
  }

  return { maxFeePerGas, maxPriorityFeePerGas, gasLimit };
}

// ── Chain metadata ───────────────────────────────────────────────

export interface ChainMeta {
  chain: string;      // canonical name, e.g. "ETH"
  chainId: number;    // EVM chain id
  networkKey: string; // lowercase, e.g. "eth"
  accountKey: string; // "ETH" (EVM family) or "SOL"
}

/**
 * Minimal chain resolution — uses gatewayChainConfig() and picks
 * the requested chain out of the response. Used by preview builders.
 */
async function resolveChainMeta(
  gw: GatewayApiClient,
  chain: string,
): Promise<ChainMeta> {
  const raw = (await gatewayChainConfig(gw)) as {
    network?: Record<string, {
      networkChainID?: number | string;
      chainId?: number | string;
      networkKey?: string;
      structureNetworkKey?: string;
      accountKey?: string;
      chain?: string;
      chainType?: string;
      chainArchitecture?: string;
    }>;
  };
  const key = chain.toUpperCase();
  const entry = raw.network?.[key];
  if (!entry) {
    throw new Error(`chain ${chain} not found in chain config`);
  }
  const canonical = entry.chain ?? entry.networkKey ?? key;
  const chainId = Number(entry.networkChainID ?? entry.chainId ?? 0);
  const networkKey = (
    entry.structureNetworkKey ?? entry.networkKey ?? canonical
  ).toLowerCase();
  const isSol =
    (entry.chainType ?? "").toLowerCase() === "sol" ||
    (entry.chainArchitecture ?? "").toUpperCase() === "SOL" ||
    networkKey === "sol";
  const accountKey =
    (entry.accountKey ?? "").toUpperCase() || (isSol ? "SOL" : "ETH");
  return {
    chain: canonical,
    chainId,
    networkKey,
    accountKey,
  };
}

// ── Public API ───────────────────────────────────────────────────

export interface TransferPreviewInput {
  from: string;
  to: string;
  amount: string;          // human-readable
  chain?: string;          // default "ETH"
  token?: string;          // "ETH"/"NATIVE"/"SOL"/"USDT" or display symbol
  tokenContract?: string;  // EVM ERC20 contract address
  tokenMint?: string;      // Solana SPL mint address
  tokenDecimals?: number;  // optional override
  nonce?: number;          // optional EVM nonce override
  maxFeePerGas?: bigint;   // optional EVM fee override
  maxPriorityFeePerGas?: bigint;
  priorityFeeMicroLamports?: bigint; // Solana
  mcpToken: string;
}

export interface TransferPreviewResult {
  key_info: Record<string, unknown>;
  confirm_message: string;
  unsigned_tx_hex: string;
  warning?: string;
}

/**
 * Drop-in replacement for `dex_tx_transfer_preview`.
 *
 * Returns `unsigned_tx_hex` that can be passed to BW sign-transaction.
 * For EVM: 0x-prefixed hex (type-2 EIP-1559).
 * For Solana: base58-encoded serialized legacy transaction.
 */
export async function buildTransferPreview(
  input: TransferPreviewInput,
): Promise<TransferPreviewResult> {
  const gw = createGatewayApiClient(input.mcpToken);

  const chainIn = (input.chain ?? "ETH").trim();
  const token = (input.token ?? "").trim() || undefined;
  const meta = await resolveChainMeta(gw, chainIn);

  if (meta.accountKey === "SOL") {
    return buildSolanaPreview(gw, input, meta);
  }
  if (meta.accountKey !== "ETH") {
    throw new Error(
      `transfer_preview currently only supports account_key=SOL or ETH; chain ${meta.chain} has account_key ${meta.accountKey}`,
    );
  }
  return buildEvmPreview(gw, input, meta, token);
}

// ── EVM preview ──────────────────────────────────────────────────

async function buildEvmPreview(
  gw: GatewayApiClient,
  input: TransferPreviewInput,
  meta: ChainMeta,
  tokenInput: string | undefined,
): Promise<TransferPreviewResult> {
  const { from, to, amount } = input;
  if (!from || !to || !amount) {
    throw new Error("from, to, amount are required");
  }
  const nonce = input.nonce != null
    ? BigInt(input.nonce)
    : await gatewayGetEvmNonce(gw, meta.chain, from).catch(() => 0n);

  let toAddress: string;
  let value: bigint;
  let dataHex: string;
  let amountRaw: bigint;
  let tokenDecimals: number;
  let tokenDisplay: string;
  let warning = "";

  const tokenContract = input.tokenContract?.trim().toLowerCase() ?? "";

  if (tokenContract) {
    // any ERC20 via explicit contract
    const contractStripped = tokenContract.replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(contractStripped)) {
      throw new Error("token_contract must be a 40-char hex address");
    }
    const contractAddr = "0x" + contractStripped;
    let decimals = input.tokenDecimals;
    if (decimals == null) {
      try {
        decimals = await gatewayGetERC20Decimals(gw, meta.networkKey, contractAddr);
      } catch {
        decimals = 18;
      }
    }
    tokenDecimals = decimals;
    tokenDisplay = tokenInput || "ERC20";
    const parsed = parseAmountWithPrecisionCheck(amount, decimals, tokenDisplay);
    warning = parsed.warning;
    amountRaw = parsed.amount;
    toAddress = contractAddr;
    value = 0n;
    dataHex = buildERC20TransferData(to, amountRaw);
  } else {
    const t = (tokenInput ?? "ETH").toUpperCase();
    const isUsdt = t === "USDT";
    if (!isUsdt) {
      // Any non-USDT symbol without an explicit contract is treated as the chain's native coin
      tokenDecimals = 18;
      tokenDisplay = tokenInput || meta.chain;
      const parsed = parseAmountWithPrecisionCheck(amount, 18, "native token");
      warning = parsed.warning;
      amountRaw = parsed.amount;
      toAddress = to;
      value = amountRaw;
      dataHex = "0x";
    } else {
      const usdt = getUSDTContract(meta.networkKey);
      if (!usdt) {
        throw new Error(
          "USDT contract not configured for this chain; use token_contract and token_decimals to specify the ERC20 contract",
        );
      }
      tokenDecimals = getUSDTDecimals(meta.networkKey);
      tokenDisplay = "USDT";
      const parsed = parseAmountWithPrecisionCheck(amount, tokenDecimals, "USDT");
      warning = parsed.warning;
      amountRaw = parsed.amount;
      toAddress = usdt;
      value = 0n;
      dataHex = buildERC20TransferData(to, amountRaw);
    }
  }

  const fallbackLimit = dataHex === "0x" ? 21000 : 100000;
  const gas = await estimateEvmGas(
    gw,
    meta.networkKey,
    from,
    toAddress,
    dataHex,
    value.toString(),
    fallbackLimit,
  );

  let maxFeePerGas = input.maxFeePerGas ?? gas.maxFeePerGas;
  let maxPriorityFeePerGas = input.maxPriorityFeePerGas ?? gas.maxPriorityFeePerGas;
  if (maxPriorityFeePerGas === 0n && maxFeePerGas > 0n) maxPriorityFeePerGas = 1n;
  if (needsGweiAlignment(meta.chainId)) {
    maxFeePerGas = alignToGwei(maxFeePerGas);
    maxPriorityFeePerGas = alignToGwei(maxPriorityFeePerGas);
  }

  const unsignedHex = buildEIP1559UnsignedHex({
    chainId: meta.chainId,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit: gas.gasLimit,
    to: toAddress,
    value,
    dataHex,
  });

  const { minAmount, description } = getTokenPrecisionInfo(tokenDisplay, meta.networkKey);
  const confirmMsg = `EVM Transfer Preview:
• Token: ${tokenDisplay} (${description}, minimum amount: ${minAmount})
• Amount: ${amount} ${tokenDisplay} = ${amountRaw.toString()} smallest unit
• Chain: ${meta.chain} (ChainID: ${meta.chainId})
• Gas Limit: ${gas.gasLimit}, Max Fee: ${maxFeePerGas.toString()} wei
${warning ? "• ⚠️  " + warning + "\n" : ""}After confirmation, sign with dex_wallet_sign_transaction.`;

  const summary = `Transfer ${amount} ${tokenDisplay} from ${from} to ${to} on ${meta.chain}`;

  return {
    unsigned_tx_hex: unsignedHex,
    confirm_message: confirmMsg,
    warning: warning || undefined,
    key_info: {
      from,
      to,
      amount,
      token: tokenDisplay,
      chain: meta.chain,
      token_contract: tokenContract ? toAddress : "native",
      amount_raw: amountRaw.toString(),
      decimals: tokenDecimals,
      gas_limit: gas.gasLimit,
      max_fee_per_gas: maxFeePerGas.toString(),
      max_priority_fee_per_gas: maxPriorityFeePerGas.toString(),
      nonce: nonce.toString(),
      summary,
    },
  };
}

// ── Solana preview ───────────────────────────────────────────────

async function buildSolanaPreview(
  gw: GatewayApiClient,
  input: TransferPreviewInput,
  meta: ChainMeta,
): Promise<TransferPreviewResult> {
  const { from, to, amount } = input;
  if (!from || !to || !amount) {
    throw new Error("from, to, amount are required");
  }
  const priorityFee = input.priorityFeeMicroLamports ?? 0n;

  if (input.tokenMint && input.tokenMint.trim()) {
    const mint = input.tokenMint.trim();
    const decimals = input.tokenDecimals;
    if (decimals == null || decimals < 0 || decimals > 255) {
      throw new Error("token_decimals is required (0-255) when token_mint is set for SPL transfer");
    }
    const parsed = parseAmountWithPrecisionCheck(amount, decimals, "SPL");
    const rawTx = await buildSolanaSPLTransferFromBase58(
      from,
      to,
      mint,
      parsed.amount,
      () => gatewayGetSolanaBlockhash(gw),
      priorityFee,
    );
    const unsignedB58 = encodeBase58(rawTx);
    const tokenSym = input.token || "SPL";
    const confirmMsg = `Solana SPL Transfer Preview:
• Token Mint: ${mint}
• Amount: ${amount} (decimals=${decimals})
${parsed.warning ? "• ⚠️  " + parsed.warning + "\n" : ""}• Note: blockhash is valid for ~90 seconds; sign and broadcast promptly.
After confirmation, sign with dex_wallet_sign_transaction(raw_tx=unsigned_tx_hex, chain=SOL).`;
    return {
      unsigned_tx_hex: unsignedB58,
      confirm_message: confirmMsg,
      warning: parsed.warning || undefined,
      key_info: {
        from,
        to,
        amount,
        token: tokenSym,
        chain: meta.chain,
        token_mint: mint,
        amount_raw: parsed.amount.toString(),
        decimals,
      },
    };
  }

  // native SOL
  const token = (input.token ?? "SOL").toUpperCase();
  if (token !== "SOL" && token !== "NATIVE") {
    throw new Error(
      "Solana chain: use token_mint + token_decimals for SPL tokens, or token=SOL for native SOL",
    );
  }
  const parsed = parseAmountWithPrecisionCheck(amount, SOLANA_NATIVE_DECIMALS, "SOL");
  const blockhash = await gatewayGetSolanaBlockhash(gw);
  const rawTx = buildSolanaTransferFromBase58(from, to, blockhash, parsed.amount, priorityFee);
  const unsignedB58 = encodeBase58(rawTx);

  const confirmMsg = `Solana Transfer Preview:
• Token: SOL (9 decimals, minimum: 0.000000001)
• Amount: ${amount} SOL = ${parsed.amount.toString()} lamports
${parsed.warning ? "• ⚠️  " + parsed.warning + "\n" : ""}• Tip: blockhash is valid ~90s; sign+broadcast promptly, or call get_sol_unsigned again for a fresh blockhash.`;

  return {
    unsigned_tx_hex: unsignedB58,
    confirm_message: confirmMsg,
    warning: parsed.warning || undefined,
    key_info: {
      from,
      to,
      amount,
      amount_lamports: parsed.amount.toString(),
      token: "SOL",
      chain: meta.chain,
      summary: `Transfer ${amount} SOL from ${from} to ${to} on ${meta.chain}`,
    },
  };
}

// ── Fresh Solana unsigned (drop-in for dex_tx_get_sol_unsigned) ───

export interface SolUnsignedInput {
  from: string;
  to: string;
  amount: string; // SOL, human-readable
  priorityFeeMicroLamports?: bigint;
  mcpToken: string;
}

/** Drop-in for `dex_tx_get_sol_unsigned` — builds fresh native SOL unsigned tx. */
export async function buildSolUnsigned(
  input: SolUnsignedInput,
): Promise<{ unsigned_tx_hex: string; key_info: Record<string, unknown> }> {
  const { from, to, amount } = input;
  if (!from || !to || !amount) {
    throw new Error("from, to, amount are required");
  }
  const gw = createGatewayApiClient(input.mcpToken);
  const parsed = parseAmountWithPrecisionCheck(amount, SOLANA_NATIVE_DECIMALS, "SOL");
  const blockhash = await gatewayGetSolanaBlockhash(gw);
  const rawTx = buildSolanaTransferFromBase58(
    from,
    to,
    blockhash,
    parsed.amount,
    input.priorityFeeMicroLamports ?? 0n,
  );
  return {
    unsigned_tx_hex: encodeBase58(rawTx),
    key_info: {
      from,
      to,
      amount,
      amount_lamports: parsed.amount.toString(),
      blockhash,
    },
  };
}
