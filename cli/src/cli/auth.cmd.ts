import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { openBrowser } from "../core/oauth.js";
import {
  saveAuth,
  loadAuth,
  clearAuth,
  getAuthFilePath,
  getBwAccessToken,
  getOrCreateDeviceToken,
} from "../core/token-store.js";
import {
  GvClient,
  getGvBaseUrl,
} from "../core/gv-client.js";
import { clientHeaders } from "../core/client-headers.js";
import {
  createWalletApiClient,
  createBwApiClient,
  createMarketApiClient,
  createDataApiClient,
  createMarketTradeClient,
  createSwapApiClient,
  getBizWalletUrl,
  getBwAppId,
  normalizeMarketChain,
} from "../core/api-client.js";
import {
  buildTransferPreview,
  buildSolUnsigned,
} from "../core/transfer/index.js";
import {
  getWeb3DomainInfo,
  refreshWeb3Domains,
} from "../core/remote-config.js";
import {
  createGatewayApiClient,
  gatewayChainConfig,
  gatewayRpcCall,
  gatewayTokenList,
  normalizeNetworkKey,
  gatewayEvmGasPrice,
  gatewayEvmGasLimit,
  gatewaySolGasPrice,
  gatewaySolGasLimit,
  gatewayTransList,
  gatewayTransDetail,
  gatewaySendRawTransaction,
} from "../core/gateway-client.js";
import {
  swapPrepare,
  swapCheckinPreview,
  swapSignApprove,
  swapSignSwap,
  swapSubmit,
} from "../core/swap/index.js";

export function registerAuthCommands(program: Command) {
  program
    .command("login")
    .description("Login (opens browser)")
    .option("--google", "Use Google OAuth instead of Gate")
    .option("--no-open", "Print authorization URL without opening browser")
    .action(async function (this: Command, opts: { google?: boolean; open: boolean }) {
      const stored = loadAuth();
      if (stored) {
        console.log(
          chalk.green("Already logged in (session restored from disk)"),
        );
        if (stored.user_id)
          console.log(chalk.green(`  User ID: ${stored.user_id}`));
        console.log(chalk.green(`  Provider: ${stored.provider}`));
        console.log(
          chalk.gray(`  Run ${chalk.white("logout")} to switch accounts.`),
        );
        return;
      }

      try {
        if (opts.google) {
          await loginGoogleViaRest(!opts.open);
          return;
        }
        await loginGateViaRest(!opts.open);
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
      }
    });

  program
    .command("web3-domain")
    .description("查看 / 刷新动态 web3_domain 列表（含测速）")
    .option("--refresh", "忽略缓存，强制重新拉取")
    .action(async function (this: Command, opts: { refresh?: boolean }) {
      try {
        const spinner = ora(opts.refresh ? "刷新动态域名..." : "解析动态域名...").start();
        const info = opts.refresh
          ? { all: await refreshWeb3Domains() }
          : await getWeb3DomainInfo();
        spinner.succeed("解析成功");
        if ("primary" in info) {
          console.log(chalk.bold("Primary:"), chalk.green(info.primary || "-"));
          console.log(chalk.bold("Available:"), info.available.length);
        }
        console.log(chalk.bold("All:"));
        for (const d of info.all) {
          const mark =
            d.available === false
              ? chalk.red("✘")
              : chalk.green(`${d.response_time_ms ?? "?"}ms`);
          console.log(`  ${mark}  ${d.host}`);
        }
        if ("cache_path" in info) {
          console.log(chalk.gray(`\nCache: ${info.cache_path}`));
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });

  program
    .command("status")
    .description("检查登录状态")
    .action(() => {
      const auth = loadAuth();
      if (!auth) {
        console.log(chalk.red("未登录"));
        console.log(chalk.gray("  Run 'login' to sign in."));
        return;
      }
      const expired = auth.expires_at && auth.expires_at < Date.now();
      if (expired) {
        console.log(chalk.yellow("Token 已过期，请重新登录"));
        console.log(chalk.gray("  Run 'login' to sign in again."));
        return;
      }
      console.log(chalk.green("已登录"));
      if (auth.user_id) console.log(chalk.green(`  User ID:     ${auth.user_id}`));
      if (auth.account_id) console.log(chalk.green(`  Account ID:  ${auth.account_id}`));
      console.log(chalk.green(`  Provider:    ${auth.provider}`));
      if (auth.evm_address) console.log(chalk.green(`  EVM Address: ${auth.evm_address}`));
      if (auth.sol_address) console.log(chalk.green(`  SOL Address: ${auth.sol_address}`));
      if (auth.expires_at) {
        const expiresDate = new Date(auth.expires_at).toLocaleString();
        console.log(chalk.gray(`  Expires at:  ${expiresDate}`));
      }
    });

  program
    .command("logout")
    .description("Logout and clear local token")
    .action(async () => {
      const auth = loadAuth();
      if (auth) {
        try {
          const bwClient = await createBwApiClient(getBwAccessToken(auth));
          await bwClient.logout();
          console.log(chalk.gray("Server session cleared."));
        } catch (err) {
          console.log(chalk.yellow(`Server logout failed (local token will still be cleared): ${(err as Error).message}`));
        }
      }
      clearAuth();
      console.log(chalk.gray("Logged out. Token cleared."));
    });

}

export function registerShortcutCommands(program: Command) {
  // ─── Wallet ──────────────────────────────────────────────
  program.command("balance").description("查询总资产余额").action(async () => {
    try {
      const auth = loadAuth();
      if (!auth) throw new Error("Not logged in. Run: login");
      const accountId = auth.account_id ?? auth.user_id;
      if (!accountId) throw new Error("account_id not found, please re-login");
      const spinner = ora("查询总资产余额...").start();
      const client = createWalletApiClient(auth.mcp_token);
      const result = await client.getTotalAsset(accountId);
      spinner.succeed("查询成功");
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
    }
  });
  program
    .command("address")
    .description("查询钱包地址")
    .action(async () => {
      try {
        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        console.log(JSON.stringify({
          evm_address: auth.evm_address,
          sol_address: auth.sol_address,
        }, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("tokens")
    .description("查询 token 列表和余额（网关 /wallet/token-list）")
    .option("--chain <keys>", "按 networkKey 过滤，逗号分隔，例如 ETH,SOL")
    .option("--page <n>", "页码", "1")
    .option("--size <n>", "每页条数", "20")
    .option("--manage <0|1>", "isManageToken (0=展示 / 1=管理)", "0")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        if (!auth.user_id) throw new Error("user_id not found, please re-login");
        const spinner = ora("查询 token 列表...").start();
        const client = createGatewayApiClient(auth.mcp_token);
        const networkKeyList = opts.chain
          ? opts.chain.split(",").map((s) => normalizeNetworkKey(s.trim())).filter(Boolean)
          : [];
        const result = await gatewayTokenList(client, {
          accountID: auth.account_id ?? auth.user_id,
          isManageToken: opts.manage ?? "0",
          networkKeyList,
          page: opts.page ? Number(opts.page) : 1,
          pageSize: opts.size ? Number(opts.size) : 20,
        });
        spinner.succeed(`查询成功 (${result.coinArrValidate?.length ?? 0} 个 token)`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("sign-msg <message>")
    .description(
      "签名消息（32 字节 / 64 位 hex 字符串），自动完成 GV 安全校验后签名",
    )
    .option("--chain <chain>", "链名称: ETH | ARB | BSC | SOL 等", "ETH")
    .action(async function (
      this: Command,
      message: string,
      opts: Record<string, string | undefined>,
    ) {
      try {
        if (!/^[0-9a-fA-F]{64}$/.test(message)) {
          console.error(
            chalk.red(
              "message 必须为 64 位十六进制字符串 (32 bytes)，例如: aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
            ),
          );
          return;
        }

        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        if (!auth.user_id) throw new Error("user_id not found, please re-login");
        const chain = (opts.chain ?? "ETH").toUpperCase();

        // Step 1: 获取钱包地址（直接用登录时缓存的地址）
        const walletAddress = (chain === "SOL" ? auth.sol_address : auth.evm_address) ?? "";
        if (!walletAddress) {
          console.error(chalk.red(`未找到钱包地址，请重新登录: pnpm cli login`));
          return;
        }

        // Step 2: GV Checkin
        const gvSpinner = ora("GV 安全校验...").start();
        let gvCheckinToken: string | undefined;
        try {
          const gvClient = new GvClient({
            baseUrl: getGvBaseUrl(),
            mcpToken: auth.mcp_token,
            deviceToken: getOrCreateDeviceToken(),
          });

          const checkinResult = await gvClient.txCheckin({
            wallet_address: walletAddress,
            message,
            module: "/wallet/sign-message",
            source: 4,
          });

          gvCheckinToken = checkinResult.checkin_token;
          gvSpinner.succeed("GV 校验通过");

          if (checkinResult.need_otp) {
            const { createInterface } = await import("node:readline");
            const rl = createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            const otpCode = await new Promise<string>((resolve) => {
              rl.question(
                chalk.yellow("  请输入 OTP 验证码: "),
                (answer) => {
                  rl.close();
                  resolve(answer.trim());
                },
              );
            });
            const otpSpinner = ora("OTP 验证中...").start();
            await gvClient.verifyOtp(gvCheckinToken, walletAddress, otpCode);
            otpSpinner.succeed("OTP 验证通过");
          }
        } catch (err) {
          gvSpinner.fail(`GV 校验失败: ${(err as Error).message}`);
          return;
        }

        // Step 3: 签名消息
        const signSpinner = ora("签名消息...").start();
        const bwClient = await createBwApiClient(getBwAccessToken(auth));
        const signResult = await bwClient.signMessage({
          message,
          chain,
          checkinToken: gvCheckinToken ?? "",
        });

        if (signResult?.signature) {
          signSpinner.succeed("签名成功");
          console.log(chalk.green(`  Signature: ${signResult.signature}`));
        } else {
          signSpinner.fail("签名失败");
          console.log(JSON.stringify(signResult, null, 2));
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("sign-tx <raw_tx>")
    .description("签名原始交易（hex），自动完成 GV 安全校验后签名")
    .option("--chain <chain>", "链名称: ETH | SOL 等", "ETH")
    .option("--to <address>", "收款地址（用于 GV intent）")
    .option("--amount <amount>", "金额（用于 GV intent）")
    .option("--token <token>", "代币符号（用于 GV intent）", "ETH")
    .action(async function (this: Command, rawTx: string, opts: Record<string, string | undefined>) {
      try {
        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        if (!auth.user_id) throw new Error("user_id not found, please re-login");
        const chain = (opts.chain ?? "ETH").toUpperCase();

        // Step 1: 获取钱包地址（直接用登录时缓存的地址）
        const walletAddress = (chain === "SOL" ? auth.sol_address : auth.evm_address) ?? "";
        if (!walletAddress) {
          console.error(chalk.red(`未找到钱包地址，请重新登录: pnpm cli login`));
          return;
        }

        // Step 2: GV Checkin（用 intent 对象，与 send 命令保持一致）
        const gvSpinner = ora("GV 安全校验...").start();
        let gvCheckinToken = "";
        try {
          const gvClient = new GvClient({
            baseUrl: getGvBaseUrl(),
            mcpToken: auth.mcp_token,
            deviceToken: getOrCreateDeviceToken(),
          });
          const checkinResult = await gvClient.txCheckin({
            wallet_address: walletAddress,
            intent: {
              chain,
              from: walletAddress,
              to: opts.to ?? walletAddress,
              amount: opts.amount ?? "0",
              token: opts.token ?? chain,
            },
            module: "/wallet/transfer",
            source: 4,
          });
          gvCheckinToken = checkinResult.checkin_token;
          gvSpinner.succeed("GV 校验通过");

          if (checkinResult.need_otp) {
            const { createInterface } = await import("node:readline");
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const otpCode = await new Promise<string>((resolve) => {
              rl.question(chalk.yellow("  请输入 OTP 验证码: "), (answer) => { rl.close(); resolve(answer.trim()); });
            });
            const otpSpinner = ora("OTP 验证中...").start();
            await gvClient.verifyOtp(gvCheckinToken, walletAddress, otpCode);
            otpSpinner.succeed("OTP 验证通过");
          }
        } catch (err) {
          gvSpinner.fail(`GV 校验失败: ${(err as Error).message}`);
          return;
        }

        // Step 3: 签名交易
        const signSpinner = ora("签名交易...").start();
        const bwClient = await createBwApiClient(getBwAccessToken(auth));
        const result = await bwClient.signTransaction({ rawTx, chain, checkinToken: gvCheckinToken });
        signSpinner.succeed("签名成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });

  // ─── Transaction ─────────────────────────────────────────
  program
    .command("gas")
    .description("查询 Gas 费用（网关 /gasprice + /gaslimit；SOL 的 gas-limit 需 --data）")
    .argument("[chain]", "链名 (ETH/SOL/BSC...)")
    .option("--chain <chain>", "链名")
    .option("--from <address>", "发送方地址")
    .option("--to <address>", "接收方地址")
    .option("--value <value>", "金额 (hex)")
    .option("--data <data>", "calldata (EVM hex / SOL base64)")
    .action(async function (this: Command, posChain?: string, opts?: Record<string, string | undefined>) {
      try {
        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        const GAS_CHAIN_ALIAS: Record<string, string> = {
          ARB: "ARBITRUM", OP: "OPTIMISM", AVAX: "AVALANCHE", MATIC: "POLYGON",
        };
        const raw = (posChain ?? opts?.chain ?? "ETH").toUpperCase();
        const chain = GAS_CHAIN_ALIAS[raw] ?? raw;
        const spinner = ora(`查询 ${chain} Gas...`).start();
        const gw = createGatewayApiClient(auth.mcp_token);

        if (chain === "SOL" || chain === "SOLANA") {
          const [price, limit] = await Promise.all([
            gatewaySolGasPrice(gw),
            opts?.data ? gatewaySolGasLimit(gw, opts.data) : Promise.resolve(null),
          ]);
          spinner.succeed("查询成功 (SOL)");
          console.log(JSON.stringify({ gas_price: price, gas_limit: limit }, null, 2));
        } else {
          const [price, limit] = await Promise.all([
            gatewayEvmGasPrice(gw, chain),
            (opts?.from && opts?.to)
              ? gatewayEvmGasLimit(gw, { chain, from: opts.from, to: opts.to, data: opts?.data, value: opts?.value })
              : Promise.resolve(null),
          ]);
          spinner.succeed(`查询成功 (${chain})`);
          console.log(JSON.stringify({ gas_price: price, gas_limit: limit }, null, 2));
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("transfer")
    .description("转账预览（本地构建 unsigned tx，不广播）")
    .option("--chain <chain>", "链名 (ETH/BSC/SOL...)")
    .option("--to <address>", "收款地址")
    .option("--amount <amount>", "金额")
    .option("--from <address>", "付款地址 (默认自动获取)")
    .option("--token <contract>", "Token 合约/Mint 地址 (原生币可不填)")
    .option("--token-decimals <decimals>", "Token 精度 (SOL SPL 代币需要)")
    .option("--token-symbol <symbol>", "Token 符号 (用于显示，如 TRUMP/USDC)")
    .option("--nonce <n>", "EVM nonce (默认自动获取)")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        if (!auth.user_id) throw new Error("user_id not found, please re-login");

        const chain = (opts.chain ?? "ETH").toUpperCase();
        let from = opts.from;
        if (!from) {
          from = (chain === "SOL" ? auth.sol_address : auth.evm_address) ?? "";
          if (!from) throw new Error(`未找到钱包地址，请重新登录: pnpm cli login`);
        }
        if (!opts.to || !opts.amount) {
          throw new Error("--to 和 --amount 必填");
        }

        const spinner = ora("转账预览...").start();
        const tokenArg = opts.token?.trim();
        const previewInput: Parameters<typeof buildTransferPreview>[0] = {
          from,
          to: opts.to,
          amount: opts.amount,
          chain,
          token: opts.tokenSymbol,
          tokenDecimals: opts.tokenDecimals ? Number(opts.tokenDecimals) : undefined,
          nonce: opts.nonce ? Number(opts.nonce) : undefined,
          mcpToken: auth.mcp_token,
        };
        if (tokenArg) {
          if (chain === "SOL") previewInput.tokenMint = tokenArg;
          else previewInput.tokenContract = tokenArg;
        } else if (chain === "SOL") {
          previewInput.token = "SOL";
        } else {
          previewInput.token = opts.tokenSymbol ?? "ETH";
        }

        const result = await buildTransferPreview(previewInput);
        spinner.succeed("预览成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  // ─── 一键转账 (Preview → Sign → Broadcast) ────────────
  program
    .command("send")
    .description("一键转账 (Preview→Sign→Broadcast)")
    .option("--chain <chain>", "链名 (ETH/SOL/BSC...)")
    .option("--to <address>", "收款地址")
    .option("--amount <amount>", "金额")
    .option("--from <address>", "付款地址 (默认自动获取)")
    .option("--token <contract>", "Token 合约/Mint 地址 (原生币可不填)")
    .option(
      "--token-decimals <decimals>",
      "Token 精度 (SPL 代币必填或自动查询)",
    )
    .option("--token-symbol <symbol>", "Token 符号 (用于显示，如 TRUMP/USDC)")
    .action(async function (
      this: Command,
      opts: Record<string, string | undefined>,
    ) {
      try {
        const sendAuth = loadAuth();
        if (!sendAuth?.user_id) throw new Error("Not logged in. Run: login");
        const chain = (opts.chain ?? "ETH").toUpperCase();

        const accountId = sendAuth.account_id ?? sendAuth.user_id ?? "";
        const from = opts.from ?? (chain === "SOL" ? sendAuth.sol_address : sendAuth.evm_address) ?? "";

        if (!opts.to || !opts.amount) {
          console.error(chalk.red("--to 和 --amount 是必填项"));
          return;
        }

        // Step 1: Preview (local build — no MCP call)
        const previewSpinner = ora("转账预览...").start();
        const tokenArg = opts.token?.trim();
        const previewInput: Parameters<typeof buildTransferPreview>[0] = {
          from,
          to: opts.to,
          amount: opts.amount,
          chain,
          token: opts.tokenSymbol,
          tokenDecimals: opts.tokenDecimals ? Number(opts.tokenDecimals) : undefined,
          mcpToken: sendAuth.mcp_token,
        };
        if (tokenArg) {
          if (chain === "SOL") previewInput.tokenMint = tokenArg;
          else previewInput.tokenContract = tokenArg;
        } else if (chain === "SOL") {
          previewInput.token = "SOL";
        } else {
          previewInput.token = opts.tokenSymbol ?? "ETH";
        }
        const previewResult = await buildTransferPreview(previewInput);
        const unsignedTx = previewResult.unsigned_tx_hex;
        const keyInfo = previewResult.key_info;
        const token = (keyInfo.token as string) ?? chain;
        previewSpinner.succeed(
          `预览成功：${keyInfo.summary ?? `${opts.amount} ${token} → ${opts.to}`}`,
        );

        // SOL native: refresh blockhash right before signing (SPL tokens skip — ATA already built)
        let txToSign = unsignedTx;
        if (chain === "SOL" && !tokenArg) {
          const freshSpinner = ora("获取最新 blockhash...").start();
          try {
            const fresh = await buildSolUnsigned({
              from,
              to: opts.to,
              amount: opts.amount,
              mcpToken: sendAuth.mcp_token,
            });
            txToSign = fresh.unsigned_tx_hex;
            freshSpinner.succeed("已获取最新 unsigned_tx");
          } catch (err) {
            freshSpinner.warn(
              `未能刷新 blockhash (${(err as Error).message})，使用预览的 unsigned_tx`,
            );
          }
        }

        // Step 2: GV Checkin（获取 checkin_token，用于后续签名校验）
        const gvSpinner = ora("GV 安全校验...").start();
        let gvCheckinToken: string | undefined;
        try {
          const auth = loadAuth();
          const mcpToken = auth?.mcp_token ?? "";
          const gvClient = new GvClient({
            baseUrl: getGvBaseUrl(),
            mcpToken,
            deviceToken: getOrCreateDeviceToken(),
          });

          const checkinResult = await gvClient.txCheckin({
            wallet_address: from,
            intent: {
              chain,
              from,
              to: opts.to,
              amount: opts.amount,
              token: token,
            },
            module: "/wallet/transfer",
            source: 4,
          });

          gvCheckinToken = checkinResult.checkin_token;
          gvSpinner.succeed("GV 校验通过");

          if (checkinResult.need_otp) {
            const { createInterface } = await import("node:readline");
            const rl = createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            const otpCode = await new Promise<string>((resolve) => {
              rl.question(chalk.yellow("  请输入 OTP 验证码: "), (answer) => {
                rl.close();
                resolve(answer.trim());
              });
            });
            const otpSpinner = ora("OTP 验证中...").start();
            await gvClient.verifyOtp(gvCheckinToken, from, otpCode);
            otpSpinner.succeed("OTP 验证通过");
          }
        } catch (err) {
          gvSpinner.fail(`GV 校验失败: ${(err as Error).message}`);
          return;
        }

        // Step 3: Sign
        const signSpinner = ora("签名交易...").start();
        const sendBwClient = await createBwApiClient(getBwAccessToken(sendAuth));
        const signResult = await sendBwClient.signTransaction({
          rawTx: txToSign,
          chain,
          checkinToken: gvCheckinToken ?? "",
        });

        const signedTx = signResult.signedTransactionWith0x ?? signResult.signedTransaction;
        if (!signedTx) {
          signSpinner.fail("签名失败");
          console.log(JSON.stringify(signResult, null, 2));
          return;
        }
        signSpinner.succeed("签名成功");

        // Step 4: Broadcast via gateway
        const broadcastSpinner = ora("广播交易...").start();
        const gwClient = createGatewayApiClient(sendAuth.mcp_token);
        const isSol = chain === "SOL";
        const chainType = isSol ? "SOL" : "EVM";
        const tokenContract = String(keyInfo.token_contract ?? "");
        const amountRaw = String(keyInfo.amount_raw ?? keyInfo.amount_lamports ?? "0");
        const rpcAddress = isSol
          ? "https://api.mainnet-beta.solana.com"
          : undefined;
        const result = await gatewaySendRawTransaction(gwClient, {
          chain_name: chain,
          params: [signedTx],
          rpc_address: rpcAddress,
          account_id: accountId,
          trace: {
            user_id: sendAuth.user_id,
            wallet_address: from,
            wallet_network: chainType,
            wallet_source: "cli",
            system_type: process.platform,
            device_name: "cli",
            system_version: process.version,
            app_version: "cli",
          },
          history_data: {
            chain_type: chainType,
            address: from,
            chain_name: chain,
            token_addr: tokenContract === "native" ? "" : tokenContract,
            token_name: token,
            token_short_name: token,
            token_type: tokenContract && tokenContract !== "native" ? "ERC20" : "coin",
            trans_type: "send",
            trans_time: String(Math.floor(Date.now() / 1000)),
            trans_balance: opts.amount ?? "0",
            trans_min_unit_amount: amountRaw,
            trans_balance_usd: "0",
            trans_oppo_address: opts.to ?? "",
            trans_gas_fee: "0",
            is_contra: tokenContract && tokenContract !== "native" ? "1" : "0",
            memo: "",
            memo_name: "",
            platform_operation: "",
            platform_name: "",
          },
        });
        broadcastSpinner.succeed("广播成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });

  program
    .command("quote")
    .description("获取兑换报价 (ETH→USDT: --from-chain 1 --to-chain 1 --from - --to 0xdAC1...ec7 --native-in 1)")
    .option("--from-chain <id>", "源链 ID (ETH=1, BSC=56, SOL=501...)", "1")
    .option("--to-chain <id>", "目标链 ID (同链 swap 则和 from-chain 相同)", "1")
    .option("--from <token>", "源 token 地址, 原生币用 -")
    .option("--to <token>", "目标 token 合约地址")
    .option("--amount <amount>", "数量")
    .option("--slippage <pct>", "滑点 (0.03=3%)", "0.03")
    .option("--native-in <0|1>", "源 token 是否原生币 (1=是, 0=否)")
    .option("--native-out <0|1>", "目标 token 是否原生币 (1=是, 0=否)")
    .option("--wallet <address>", "钱包地址 (默认自动获取)")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const chainIdIn = Number(opts.fromChain ?? 1);
        const chainIdOut = Number(opts.toChain ?? opts.fromChain ?? 1);
        let wallet = opts.wallet;
        const quoteAuth = loadAuth();
        if (!wallet) {
          if (!quoteAuth?.user_id) throw new Error("Not logged in. Run: login");
          wallet = chainIdIn === 501 ? quoteAuth.sol_address : quoteAuth.evm_address;
        }
        const rawSlippage = Number(opts.slippage ?? "0.03");
        const slippage = rawSlippage >= 1 ? rawSlippage / 100 : rawSlippage;

        const spinner = ora("获取报价...").start();
        const result = await createSwapApiClient(quoteAuth ? getBwAccessToken(quoteAuth) : undefined).quote({
          chain_id_in: chainIdIn,
          chain_id_out: chainIdOut,
          token_in: opts.from ?? "-",
          token_out: opts.to ?? "",
          amount: opts.amount ?? "0",
          slippage,
          native_in: Number(opts.nativeIn ?? "0"),
          native_out: Number(opts.nativeOut ?? "0"),
          user_wallet: wallet,
        });
        spinner.succeed("报价获取成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("swap")
    .description(
      "一键兑换 (Quote → Confirm → Prepare → GV Checkin → Sign → Submit)",
    )
    .option("--from-chain <id>", "源链 ID (ETH=1, BSC=56, ARB=42161, SOL=501...)", "1")
    .option("--to-chain <id>", "目标链 ID (同链则与 from-chain 相同)")
    .option("--from <token>", "源 token 合约地址，原生币用 -")
    .option("--to <token>", "目标 token 合约地址")
    .option("--amount <amount>", "数量")
    .option("--slippage <pct>", "滑点 (0.03=3%，0.5=50%)", "0.03")
    .option("--native-in <0|1>", "源 token 是否原生币 (1=是)", "0")
    .option("--native-out <0|1>", "目标 token 是否原生币 (1=是)", "0")
    .option("--wallet <address>", "源链钱包地址（默认自动获取）")
    .option("--to-wallet <address>", "目标链钱包地址（跨链时需要）")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const swapAuth = loadAuth();
        if (!swapAuth?.user_id) throw new Error("Not logged in. Run: login");

        const accountId = swapAuth.account_id ?? swapAuth.user_id ?? "";
        const chainIdIn = Number(opts.fromChain ?? 1);
        const chainIdOut = Number(opts.toChain ?? opts.fromChain ?? 1);
        const wallet =
          opts.wallet ??
          (chainIdIn === 501 ? swapAuth.sol_address : swapAuth.evm_address) ??
          "";
        if (!wallet) throw new Error("无法获取钱包地址，请重新登录");
        if (!opts.from || !opts.to || !opts.amount) {
          throw new Error("--from / --to / --amount 必填");
        }

        const rawSlippage = Number(opts.slippage ?? "0.03");
        const slippage = rawSlippage >= 1 ? rawSlippage / 100 : rawSlippage;
        const nativeIn = Number(opts.nativeIn ?? "0");
        const nativeOut = Number(opts.nativeOut ?? "0");

        // Step 2: Quote (preview only — swapPrepare will re-quote internally)
        const quoteSpinner = ora("获取报价...").start();
        const swapApi = createSwapApiClient(getBwAccessToken(swapAuth));
        const quoteResult = (await swapApi.quote({
          chain_id_in: chainIdIn,
          chain_id_out: chainIdOut,
          token_in: nativeIn === 1 ? "-" : opts.from,
          token_out: nativeOut === 1 ? "-" : opts.to,
          amount: opts.amount,
          slippage,
          slippage_type: 2,
          swap_type: 2,
          native_in: nativeIn,
          native_out: nativeOut,
          user_wallet: wallet,
          from_wallet: wallet,
          to_wallet: opts.toWallet ?? wallet,
          extra_data: { is_multi: true },
        })) as {
          amount_out?: string;
          to_amount?: string;
          to_amount_usd?: string;
          price_impact?: string;
          gas_fee_usd?: string;
          estimate_gas_fee_amount?: string;
          routes?: Array<{ need_approved?: number }>;
          need_approved?: number;
        };
        quoteSpinner.succeed("报价获取成功");

        console.log(chalk.bold("\n兑换预览："));
        console.log(
          `  获得：${chalk.green(quoteResult.amount_out ?? quoteResult.to_amount ?? "-")}${quoteResult.to_amount_usd ? ` (~$${quoteResult.to_amount_usd})` : ""}`,
        );
        if (quoteResult.price_impact) console.log(`  价格影响：${quoteResult.price_impact}`);
        const gasFee = quoteResult.gas_fee_usd ?? quoteResult.estimate_gas_fee_amount;
        if (gasFee) console.log(`  Gas 费用：${gasFee}`);
        const quoteNeedApprove =
          (quoteResult.routes?.[0]?.need_approved ?? quoteResult.need_approved) === 2;
        if (quoteNeedApprove) {
          console.log(chalk.yellow("  ⚠️  需要先进行 Token 授权（Approve）"));
        }

        // Step 3: 用户确认
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const confirm = await new Promise<string>((resolve) => {
          rl.question(chalk.yellow("\n确认兑换? (y/N): "), (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
        });
        if (confirm !== "y") {
          console.log(chalk.gray("已取消"));
          return;
        }

        // Step 4: Prepare (quote + build + 建立本地 session)
        const prepareSpinner = ora("准备兑换会话...").start();
        const prepared = await swapPrepare({
          chain_id_in: chainIdIn,
          chain_id_out: chainIdOut,
          token_in: opts.from,
          token_out: opts.to,
          amount: opts.amount,
          slippage,
          native_in: nativeIn,
          native_out: nativeOut,
          user_wallet: wallet,
          to_wallet: opts.toWallet ?? wallet,
          account_id: accountId,
          mcp_token: swapAuth.mcp_token,
        });
        const swapSessionId = prepared.swap_session_id;
        prepareSpinner.succeed(`会话创建成功 (${swapSessionId.slice(0, 8)}...)`);

        const bwClient = await createBwApiClient(getBwAccessToken(swapAuth));
        const signer = async (signOpts: {
          rawTx: string;
          chain: "EVM" | "SOL";
          checkinToken: string;
        }) => bwClient.signTransaction(signOpts);

        // Step 5: Approve（如需要）
        if (prepared.need_approved) {
          const approveGvSpinner = ora("GV 安全校验（Approve 阶段）...").start();
          let approveCheckinToken: string;
          try {
            const preview = await swapCheckinPreview({
              swap_session_id: swapSessionId,
              stage: "approve",
            });
            const gvClient = new GvClient({
              baseUrl: getGvBaseUrl(),
              mcpToken: swapAuth.mcp_token,
              deviceToken: getOrCreateDeviceToken(),
            });
            const checkin = await gvClient.txCheckin({
              wallet_address: preview.user_wallet,
              intent: {
                chain: preview.chain,
                from: preview.user_wallet,
                type: "swap",
              },
              module: "/wallet/transfer",
              source: 4,
            });
            approveCheckinToken = checkin.checkin_token;
            approveGvSpinner.succeed("GV 校验通过（Approve）");
          } catch (err) {
            approveGvSpinner.fail(`GV 校验失败: ${(err as Error).message}`);
            return;
          }

          const approveSpinner = ora("签名 Approve...").start();
          try {
            await swapSignApprove({
              swap_session_id: swapSessionId,
              checkin_token: approveCheckinToken,
              signTransaction: signer,
            });
            approveSpinner.succeed("Approve 签名成功");
          } catch (err) {
            approveSpinner.fail(`Approve 签名失败: ${(err as Error).message}`);
            return;
          }
        }

        // Step 6: Swap GV Checkin
        const swapGvSpinner = ora("GV 安全校验（Swap 阶段）...").start();
        let swapCheckinToken: string;
        try {
          const preview = await swapCheckinPreview({
            swap_session_id: swapSessionId,
            stage: "swap",
          });
          const gvClient = new GvClient({
            baseUrl: getGvBaseUrl(),
            mcpToken: swapAuth.mcp_token,
            deviceToken: getOrCreateDeviceToken(),
          });
          const checkin = await gvClient.txCheckin({
            wallet_address: preview.user_wallet,
            intent: {
              chain: preview.chain,
              from: preview.user_wallet,
              type: "swap",
            },
            module: "/wallet/transfer",
            source: 4,
          });
          swapCheckinToken = checkin.checkin_token;
          swapGvSpinner.succeed("GV 校验通过（Swap）");
        } catch (err) {
          swapGvSpinner.fail(`GV 校验失败: ${(err as Error).message}`);
          return;
        }

        // Step 7: Sign Swap
        const signSwapSpinner = ora("签名兑换交易...").start();
        try {
          await swapSignSwap({
            swap_session_id: swapSessionId,
            checkin_token: swapCheckinToken,
            signTransaction: signer,
          });
          signSwapSpinner.succeed("Swap 签名成功");
        } catch (err) {
          signSwapSpinner.fail(`Swap 签名失败: ${(err as Error).message}`);
          return;
        }

        // Step 8: Submit
        const submitSpinner = ora("提交兑换...").start();
        try {
          const submit = await swapSubmit({ swap_session_id: swapSessionId });
          submitSpinner.succeed("兑换已提交");
          if (submit.tx_hash) console.log(chalk.green(`  Hash: ${submit.tx_hash}`));
          if (submit.tx_order_id) console.log(chalk.gray(`  Order ID: ${submit.tx_order_id}`));
        } catch (err) {
          submitSpinner.fail(`提交失败: ${(err as Error).message}`);
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("swap-detail")
    .description("查询兑换交易详情")
    .argument("<order_id>", "交易 order ID")
    .action(async function (this: Command, orderId: string) {
      try {
        const auth = loadAuth();
        if (!auth?.user_id) throw new Error("Not logged in. Run: login");
        const spinner = ora("查询兑换详情...").start();
        const result = await createSwapApiClient(getBwAccessToken(auth)).swapDetail(orderId);
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("send-tx")
    .description("构建、签名并广播转账交易（一步完成）")
    .option("--chain <chain>", "链名，如 ETH / BSC / SOL", "ETH")
    .option("--to <to>", "接收方地址（必填）")
    .option("--amount <amount>", "转账金额（必填）")
    .option("--token <symbol>", "代币符号，如 ETH / USDT / BNB")
    .option("--address <from>", "发送方地址（默认自动获取）")
    .option("--hex <signed_tx>", "已签名交易 hex（跳过 preview+sign，直接广播）")
    .option("--token-contract <contract>", "ERC20 合约地址（可选）")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const sendAuth = loadAuth();
        if (!sendAuth?.user_id) throw new Error("Not logged in. Run: login");

        const chain = (opts.chain ?? "ETH").toUpperCase();

        // Step 1: 获取钱包地址（直接用登录时缓存的地址）
        const addrSpinner = ora("获取钱包地址...").start();
        const accountId = sendAuth.account_id ?? sendAuth.user_id ?? "";
        const isSol = chain === "SOL";
        const fromAddr = opts.address ?? (isSol ? sendAuth.sol_address : sendAuth.evm_address) ?? "";
        addrSpinner.succeed(`钱包地址: ${fromAddr}`);

        let signedHex = opts.hex ?? "";
        let preview: Awaited<ReturnType<typeof buildTransferPreview>> | undefined;

        if (!signedHex) {
          // 需要 to + amount
          if (!opts.to) throw new Error("缺少 --to 接收方地址");
          if (!opts.amount) throw new Error("缺少 --amount 转账金额");

          // Step 2: 构建未签名交易
          const previewSpinner = ora("构建未签名交易...").start();
          preview = await buildTransferPreview({
            from: fromAddr,
            to: opts.to,
            amount: opts.amount,
            chain,
            token: opts.token,
            tokenContract: opts.tokenContract,
            mcpToken: sendAuth.mcp_token,
          });
          previewSpinner.succeed("未签名交易构建完成");

          // Step 3: GV 安全校验
          const gvSpinner = ora("GV 安全校验...").start();
          let checkinToken = "";
          try {
            const gvClient = new GvClient({
              baseUrl: getGvBaseUrl(),
              mcpToken: sendAuth.mcp_token,
              deviceToken: getOrCreateDeviceToken(),
            });
            const checkinResult = await gvClient.txCheckin({
              wallet_address: fromAddr,
              intent: {
                chain,
                from: fromAddr,
                to: opts.to,
                amount: opts.amount,
                token: opts.token ?? chain,
              },
              module: "/wallet/transfer",
              source: 4,
            });
            checkinToken = checkinResult.checkin_token;
            gvSpinner.succeed("GV 校验通过");

            if (checkinResult.need_otp) {
              const { createInterface } = await import("node:readline");
              const rl = createInterface({ input: process.stdin, output: process.stdout });
              const otpCode = await new Promise<string>((resolve) => {
                rl.question(chalk.yellow("  请输入 OTP 验证码: "), (answer) => { rl.close(); resolve(answer.trim()); });
              });
              const otpSpinner = ora("OTP 验证中...").start();
              await gvClient.verifyOtp(checkinToken, fromAddr, otpCode);
              otpSpinner.succeed("OTP 验证通过");
            }
          } catch (err) {
            gvSpinner.fail(`GV 校验失败: ${(err as Error).message}`);
            return;
          }

          // Step 4: 签名
          const signSpinner = ora("签名交易...").start();
          const bwClient = await createBwApiClient(getBwAccessToken(sendAuth));
          const signResult = await bwClient.signTransaction({
            rawTx: preview.unsigned_tx_hex,
            chain,
            checkinToken,
          });
          signedHex = signResult?.signedTransactionWith0x ?? signResult?.signedTransaction ?? "";
          if (!signedHex) throw new Error(`签名返回为空: ${JSON.stringify(signResult)}`);
          signSpinner.succeed("签名成功");
        }

        // Step 5: 广播
        const broadcastSpinner = ora("广播交易...").start();
        const gwClient = createGatewayApiClient(sendAuth.mcp_token);
        const ki = preview?.key_info ?? {};
        const tokenShort = String(ki["token"] ?? opts.token ?? chain);
        const tokenContract = String(ki["token_contract"] ?? "");
        const amountRaw = String(ki["amount_raw"] ?? ki["amount_lamports"] ?? "0");
        const gasLimit = Number(ki["gas_limit"] ?? 0);
        const maxFee = String(ki["max_fee_per_gas"] ?? "0");
        const gasFeeWei = gasLimit > 0 ? (BigInt(gasLimit) * BigInt(maxFee)).toString() : "0";
        const chainType = isSol ? "SOL" : "EVM";
        const rpcAddress = isSol
          ? "https://api.mainnet-beta.solana.com"
          : undefined;
        const result = await gatewaySendRawTransaction(gwClient, {
          chain_name: chain,
          params: [signedHex],
          rpc_address: rpcAddress,
          account_id: accountId,
          trace: {
            user_id: sendAuth.user_id,
            wallet_address: fromAddr,
            wallet_network: chainType,
            wallet_source: "cli",
            system_type: process.platform,
            device_name: "cli",
            system_version: process.version,
            app_version: "cli",
          },
          history_data: {
            chain_type: chainType,
            address: fromAddr,
            chain_name: chain,
            token_addr: tokenContract === "native" ? "" : tokenContract,
            token_name: tokenShort,
            token_short_name: tokenShort,
            token_type: tokenContract && tokenContract !== "native" ? "ERC20" : "coin",
            trans_type: "send",
            trans_time: String(Math.floor(Date.now() / 1000)),
            trans_balance: opts.amount ?? "0",
            trans_min_unit_amount: amountRaw,
            trans_balance_usd: "0",
            trans_oppo_address: opts.to ?? "",
            trans_gas_fee: gasFeeWei,
            is_contra: tokenContract && tokenContract !== "native" ? "1" : "0",
            memo: "",
            memo_name: "",
            platform_operation: "",
            platform_name: "",
          },
        });
        broadcastSpinner.succeed("广播成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("tx-detail")
    .description("查询交易详情 (by hash)")
    .argument("<tx_hash>", "交易 hash")
    .action(async function (this: Command, txHash: string) {
      try {
        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        const spinner = ora("查询交易详情...").start();
        const result = await gatewayTransDetail(createGatewayApiClient(auth.mcp_token), txHash);
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("tx-history")
    .description("查询交易历史")
    .option("--page <n>", "页码", "1")
    .option("--limit <n>", "每页条数", "20")
    .option("--start <time>", "开始时间 (Unix 秒)")
    .option("--end <time>", "结束时间 (Unix 秒)")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const auth = loadAuth();
        if (!auth?.user_id) throw new Error("Not logged in. Run: login");
        const spinner = ora("查询交易历史...").start();
        const result = await gatewayTransList(createGatewayApiClient(auth.mcp_token), {
          account_id: auth.account_id ?? auth.user_id,
          page_num: opts.page ? Number(opts.page) : 1,
          page_size: opts.limit ? Number(opts.limit) : 20,
          start_time: opts.start,
          end_time: opts.end,
        });
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("swap-history")
    .description("查询 Swap/Bridge 交易历史")
    .option("--page <n>", "页码", "1")
    .option("--limit <n>", "每页条数", "20")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const auth = loadAuth();
        if (!auth?.user_id) throw new Error("Not logged in. Run: login");
        const spinner = ora("查询 Swap 历史...").start();
        const result = await createSwapApiClient(getBwAccessToken(auth)).swapHistory({
          accountId: auth.account_id ?? auth.user_id,
          pageNum: opts.page ? Number(opts.page) : 1,
          pageSize: opts.limit ? Number(opts.limit) : 20,
        });
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("sol-tx")
    .description("构建 Solana 未签名转账交易（本地，使用最新 blockhash）")
    .option("--from <address>", "发送方地址（默认自动获取）")
    .option("--to <address>", "收款地址")
    .option("--amount <amount>", "金额 (SOL)")
    .option("--priority-fee <microLamports>", "优先费（micro-lamports/CU）")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        if (!auth.user_id) throw new Error("user_id not found, please re-login");
        if (!opts.to || !opts.amount) throw new Error("--to 和 --amount 必填");

        let from = opts.from;
        if (!from) {
          from = auth.sol_address ?? "";
          if (!from) throw new Error(`未找到 SOL 钱包地址，请重新登录: pnpm cli login`);
        }

        const spinner = ora("构建 Solana 未签名交易...").start();
        const result = await buildSolUnsigned({
          from,
          to: opts.to,
          amount: opts.amount,
          priorityFeeMicroLamports: opts.priorityFee ? BigInt(opts.priorityFee) : 0n,
          mcpToken: auth.mcp_token,
        });
        spinner.succeed("构建成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });

  // ─── Market ──────────────────────────────────────────────
  program
    .command("kline")
    .description("查询 K 线数据")
    .option("--chain <chain>", "链名 (eth/bsc/solana...)")
    .option("--address <addr>", "Token 合约地址")
    .option("--period <period>", "时间周期 (1m/5m/1h/4h/1d)", "1h")
    .option("--pair <addr>", "交易对地址 (可选)")
    .option("--limit <n>", "返回条数", "100")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const spinner = ora("查询 K 线数据...").start();
        const client = createMarketTradeClient();
        const result = await client.getKline({
          chain: normalizeMarketChain(opts.chain),
          tokenAddress: opts.address ?? "",
          period: opts.period ?? "1h",
          pairAddress: opts.pair,
          limit: opts.limit ? Number(opts.limit) : undefined,
        });
        spinner.succeed(`查询成功 (${result.length} 条)`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("liquidity")
    .description("查询流动性池事件")
    .option("--chain <chain>", "链名")
    .option("--address <addr>", "Token 合约地址")
    .option("--pair <addr>", "交易对地址 (可选)")
    .option("--page <n>", "页码", "1")
    .option("--size <n>", "每页条数", "20")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const spinner = ora("查询流动性池事件...").start();
        const client = createMarketTradeClient();
        const result = await client.getPairLiquidity({
          chain: normalizeMarketChain(opts.chain),
          tokenAddress: opts.address ?? "",
          pairAddress: opts.pair,
          pageIndex: opts.page ? Number(opts.page) : undefined,
          pageSize: opts.size ? Number(opts.size) : undefined,
        });
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("tx-stats")
    .description("查询交易量统计 (5m/1h/4h/24h)")
    .option("--chain <chain>", "链名")
    .option("--address <addr>", "Token 合约地址")
    .option("--pair <addr>", "交易对地址 (可选)")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const spinner = ora("查询交易量统计...").start();
        const client = createMarketTradeClient();
        const result = await client.getVolumeStats({
          chain: normalizeMarketChain(opts.chain),
          tokenAddress: opts.address ?? "",
          pairAddress: opts.pair,
        });
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("swap-tokens")
    .description("查询链上可兑换 Token 列表")
    .option("--chain <chain>", "链名 (eth/bsc/solana...)")
    .option("--search <keyword>", "搜索关键词 (symbol/address)")
    .option("--tag <tag>", "列表类型: favorite | recommend")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const spinner = ora("查询 Token 列表...").start();
        const client = createMarketApiClient(loadAuth()?.mcp_token);
        const result = await client.listSwapBridgeTokens({
          chain: opts.chain ? normalizeMarketChain(opts.chain) : undefined,
          search: opts.search,
          tag: opts.tag,
        });
        spinner.succeed(`查询成功 (${result.tokens.length} tokens)`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("bridge-tokens")
    .description("查询跨链桥目标 Token")
    .option("--src-chain <chain>", "源链 (eth/bsc/solana...)")
    .option("--dest-chain <chain>", "目标链")
    .option("--token <address>", "源 Token 合约地址")
    .option("--search <keyword>", "搜索关键词")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const spinner = ora("查询跨链桥 Token...").start();
        const client = createMarketApiClient(loadAuth()?.mcp_token);
        const result = await client.listSwapBridgeTokens({
          sourceChain: opts.srcChain ? normalizeMarketChain(opts.srcChain) : undefined,
          chain: opts.destChain ? normalizeMarketChain(opts.destChain) : undefined,
          sourceAddress: opts.token,
          search: opts.search,
        });
        spinner.succeed(`查询成功 (${result.tokens.length} tokens)`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });

  // ─── Token ───────────────────────────────────────────────
  program
    .command("token-info")
    .description("查询 Token 详情 (价格/市值/持仓分布)")
    .option("--chain <chain>", "链名")
    .option("--address <addr>", "Token 合约地址")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const spinner = ora("查询 Token 详情...").start();
        const client = createDataApiClient(loadAuth()?.mcp_token);
        const result = await client.tokenQuery({
          chain: opts.chain ? { in: [normalizeMarketChain(opts.chain)] } : undefined,
          address: opts.address ? { eq: opts.address } : undefined,
          limit: 1,
        });
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("token-risk")
    .description("查询 Token 安全审计信息")
    .option("--chain <chain>", "链名")
    .option("--address <addr>", "Token 合约地址")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const spinner = ora("查询安全审计信息...").start();
        const client = createDataApiClient(loadAuth()?.mcp_token);
        const result = await client.getSecurityRiskInfos(normalizeMarketChain(opts.chain), opts.address ?? "");
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("token-rank")
    .description("Token 涨跌幅排行榜 (24h)")
    .option("--chain <chain>", "链名")
    .option("--limit <n>", "Top N", "10")
    .option("--direction <dir>", "desc (涨幅) | asc (跌幅)", "desc")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const spinner = ora("查询排行榜...").start();
        const client = createDataApiClient(loadAuth()?.mcp_token);
        const limit = opts.limit ? Number(opts.limit) : 10;
        const direction = (opts.direction ?? "desc") as "asc" | "desc";
        const result = await client.tokenQuery({
          chain: opts.chain ? { in: [normalizeMarketChain(opts.chain)] } : undefined,
          sort: [{ field: "trend_info.price_change_24h", order: direction }],
          limit,
        });
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("new-tokens")
    .description("按创建时间筛选新 Token")
    .option("--chain <chain>", "链名")
    .option("--start <time>", "开始时间 (RFC3339, 如 2026-03-08T00:00:00Z)")
    .option("--end <time>", "结束时间 (RFC3339)")
    .option("--limit <n>", "返回条数", "20")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const spinner = ora("查询新 Token...").start();
        const client = createDataApiClient(loadAuth()?.mcp_token);
        const end = opts.end ?? new Date().toISOString();
        const result = await client.tokenQuery({
          chain: opts.chain ? { in: [normalizeMarketChain(opts.chain)] } : undefined,
          created_at: opts.start ? { range: { start: opts.start, end } } : undefined,
          sort: [{ field: "created_at", order: "desc" }],
          limit: opts.limit ? Number(opts.limit) : 20,
        });
        spinner.succeed("查询成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });

  // ─── Chain / RPC ─────────────────────────────────────────
  program
    .command("chain-config")
    .description("查询链配置 (networkKey, endpoint, chainID)")
    .argument("[chain]", "链名过滤 (不填返回全部)")
    .action(async function (this: Command, chain?: string) {
      try {
        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        const spinner = ora("查询链配置...").start();
        const data = await gatewayChainConfig(createGatewayApiClient(auth.mcp_token)) as {
          network?: Record<string, unknown>;
          [k: string]: unknown;
        };
        spinner.succeed("查询成功");
        if (chain) {
          const key = chain.toUpperCase();
          const match = data.network?.[key];
          console.log(JSON.stringify(match ?? { error: `chain ${key} not found` }, null, 2));
        } else {
          console.log(JSON.stringify(data, null, 2));
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
  program
    .command("rpc")
    .description("执行 JSON-RPC 调用 (eth_blockNumber, eth_getBalance...)")
    .option("--chain <chain>", "链名 (ETH/BSC/SOL...)")
    .option("--method <method>", "RPC 方法 (eth_blockNumber...)")
    .option("--params <json>", "参数 JSON 数组")
    .action(async function (this: Command, opts: Record<string, string | undefined>) {
      try {
        const chain = (opts.chain ?? "ETH").toUpperCase();
        let params: unknown[] = [];
        if (opts.params) {
          try {
            params = JSON.parse(opts.params) as unknown[];
          } catch {
            params = [opts.params];
          }
        }
        const auth = loadAuth();
        if (!auth) throw new Error("Not logged in. Run: login");
        const spinner = ora(`RPC ${opts.method ?? ""}...`).start();
        const result = await gatewayRpcCall(createGatewayApiClient(auth.mcp_token), {
          chain,
          method: opts.method ?? "",
          params,
        });
        spinner.succeed("RPC 调用成功");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
      }
    });
}

// ─── Google OAuth 登录（REST API + 服务端回调）─────────────

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_CLIENT_ID =
  "663295861438-ehhqhr8j2cn3hailtjmedtbcd806vca6.apps.googleusercontent.com";
const GOOGLE_SCOPE = "openid email profile";

interface DeviceStartResponse {
  flow_id?: string;
  device_code?: string;
  user_code?: string;
  verification_url?: string;
  expires_in?: number;
  interval?: number;
  state?: string;
  error?: string;
}

interface DevicePollResponse {
  status: string;
  mcp_token?: string;
  user_id?: string;
  account_id?: string;
  evm_address?: string;
  sol_address?: string;
  wallet_address?: string;
  wallets?: Array<{ wallet_address: string; chain: string }>;
  expires_in?: number;
  error?: string;
}

async function loginGoogleViaRest(noOpen = false) {
  const baseUrl = getBizWalletUrl();
  const callbackUrl = `${baseUrl}/v1/wallet/oauth/google/device/callback`;
  const loginSpinner = ora("Starting Google OAuth login...").start();

  // 1. 通过 REST API 启动 Google OAuth device flow
  let flowData: DeviceStartResponse;
  try {
    const res = await fetch(`${baseUrl}/v1/wallet/oauth/google/device/start`, {
      method: "POST",
      headers: {
        ...clientHeaders(),
        "Content-Type": "application/json",
        "x-gtweb3-device-token": getOrCreateDeviceToken(),
        "x-gtweb3-app-id": getBwAppId(),
        "source": "3",
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text}`);
    }

    flowData = (await res.json()) as DeviceStartResponse;
  } catch (err) {
    loginSpinner.fail(
      `Failed to start Google login: ${(err as Error).message}`,
    );
    return;
  }

  if (flowData.error) {
    loginSpinner.fail(`Google login error: ${flowData.error}`);
    return;
  }

  // 2. 如果服务端返回了 verification_url，直接用；否则手动构建
  let authUrl: string;
  if (flowData.verification_url) {
    authUrl = flowData.verification_url;
  } else {
    const state = flowData.state ?? flowData.flow_id ?? "";
    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    if (state) url.searchParams.set("state", state);
    authUrl = url.toString();
  }

  const flowId = flowData.flow_id ?? flowData.device_code ?? "";
  if (!flowId) {
    loginSpinner.fail("Failed to start Google login: no flow_id returned");
    return;
  }

  loginSpinner.succeed("Google OAuth flow started");

  if (flowData.user_code) {
    console.log(chalk.gray(`  Code: ${flowData.user_code}`));
  }

  if (noOpen) {
    console.log(chalk.bold("  Authorization URL:"));
    console.log(chalk.cyan(authUrl));
  } else {
    const opened = await openBrowser(authUrl);
    if (opened) {
      console.log(chalk.green("  ✔ Browser opened — please authorize there."));
    }
  }

  // 4. 轮询等待结果
  const pollSpinner = ora("Waiting for Google authorization...").start();
  const intervalMs = (flowData.interval ?? 5) * 1000;
  const deadline = Date.now() + (flowData.expires_in ?? 1800) * 1000;

  let cancelled = false;
  const abortCtrl = new AbortController();
  const onSigint = () => { cancelled = true; abortCtrl.abort(); pollSpinner.stop(); process.exit(0); };
  process.once("SIGINT", onSigint);

  while (Date.now() < deadline && !cancelled) {
    await sleep(intervalMs, abortCtrl.signal);
    if (cancelled) break;

    try {
      const res = await fetch(`${baseUrl}/v1/wallet/oauth/google/device/poll`, {
        method: "POST",
        headers: {
          ...clientHeaders(),
          "Content-Type": "application/json",
          "x-gtweb3-device-token": getOrCreateDeviceToken(),
          "x-gtweb3-app-id": getBwAppId(),
          "source": "3",
        },
        body: JSON.stringify({ flow_id: flowId }),
      });

      if (!res.ok) continue;

      const poll = (await res.json()) as DevicePollResponse;

      if (poll.status === "ok") {
        if (poll.mcp_token) {
          process.removeListener("SIGINT", onSigint);
          pollSpinner.succeed("Google login successful!");

          saveAuth({
            mcp_token: poll.mcp_token,
            provider: "google",
            user_id: poll.user_id,
            account_id: poll.account_id,
            evm_address: poll.evm_address,
            sol_address: poll.sol_address,
            expires_at: poll.expires_in
              ? Date.now() + poll.expires_in * 1000
              : Date.now() + 30 * 86_400_000,
            env: "default",
          });

          console.log();
          if (poll.user_id)
            console.log(chalk.green(`  User ID: ${poll.user_id}`));
          if (poll.wallet_address)
            console.log(chalk.green(`  Wallet: ${poll.wallet_address}`));
          console.log(chalk.green(`  Provider: Google`));
          console.log(chalk.gray(`  Token saved to ${getAuthFilePath()}`));

          return;
        }
      }

      if (poll.status === "error") {
        process.removeListener("SIGINT", onSigint);
        pollSpinner.fail(
          `Google login failed: ${poll.error ?? "Unknown error"}`,
        );
        return;
      }
    } catch {
      // poll 失败，继续轮询
    }
  }

  process.removeListener("SIGINT", onSigint);
  pollSpinner.fail(cancelled ? "Login cancelled" : "Login timed out");
}

// ─── Gate OAuth 登录（REST API + 服务端回调）──────────────

async function loginGateViaRest(noOpen = false) {
  const baseUrl = getBizWalletUrl();
  const loginSpinner = ora("Starting Gate OAuth login...").start();

  let cancelled = false;
  const abortCtrl = new AbortController();
  let currentSpinner: { stop: () => unknown } = loginSpinner;
  const cleanupAndExit = () => {
    cancelled = true;
    abortCtrl.abort();
    currentSpinner.stop();
    cleanupCtrlCWatcher();
    console.log(chalk.yellow("\nLogin cancelled."));
    process.exit(130);
  };
  process.once("SIGINT", cleanupAndExit);

  // 兜底：直接从 stdin 读 Ctrl+C 字节（0x03），绕过 SIGINT 链路
  // （某些 spinner 库 / tsx / pnpm 层会吞掉 SIGINT 信号）
  let cleanupCtrlCWatcher: () => void = () => {};
  if (process.stdin.isTTY) {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
      stdin.resume();
      const onData = (buf: Buffer) => {
        if (buf[0] === 0x03) cleanupAndExit();
      };
      stdin.on("data", onData);
      cleanupCtrlCWatcher = () => {
        stdin.off("data", onData);
        try { stdin.setRawMode(wasRaw); } catch {}
        stdin.pause();
      };
    } catch {
      // 无法切到 raw mode 就放弃，依赖 SIGINT
    }
  }

  let flowData: DeviceStartResponse;
  try {
    const res = await fetch(`${baseUrl}/v1/wallet/oauth/gate/device/start`, {
      method: "POST",
      headers: {
        ...clientHeaders(),
        "Content-Type": "application/json",
        "x-gtweb3-device-token": getOrCreateDeviceToken(),
        "x-gtweb3-app-id": getBwAppId(),
        "source": "3",
      },
      body: JSON.stringify({}),
      signal: abortCtrl.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text}`);
    }

    flowData = (await res.json()) as DeviceStartResponse;
  } catch (err) {
    cleanupCtrlCWatcher();
    process.removeListener("SIGINT", cleanupAndExit);
    loginSpinner.fail(`Failed to start Gate login: ${(err as Error).message}`);
    return;
  }

  if (flowData.error) {
    cleanupCtrlCWatcher();
    process.removeListener("SIGINT", cleanupAndExit);
    loginSpinner.fail(`Gate login error: ${flowData.error}`);
    return;
  }

  if (!flowData.verification_url || !flowData.flow_id) {
    cleanupCtrlCWatcher();
    process.removeListener("SIGINT", cleanupAndExit);
    loginSpinner.fail(
      "Failed to start Gate login: no verification_url returned",
    );
    return;
  }

  loginSpinner.succeed("Gate OAuth flow started");

  if (flowData.user_code) {
    console.log(chalk.gray(`  Code: ${flowData.user_code}`));
  }

  if (noOpen) {
    // 直接写 stderr：避开 stdout 在容器/非 TTY 下的 block-buffering，
    // 也避免下一行 ora spinner 的 \r 控制把这两行覆盖掉
    process.stderr.write(`  Authorization URL:\n  ${flowData.verification_url}\n`);
  } else {
    const opened = await openBrowser(flowData.verification_url);
    if (opened) {
      console.log(chalk.green("  ✔ Browser opened — please authorize there."));
    } else {
      // openBrowser 失败时也兜底打印 URL
      process.stderr.write(`  Authorization URL:\n  ${flowData.verification_url}\n`);
    }
  }

  const pollSpinner = ora("Waiting for Gate authorization...").start();
  currentSpinner = pollSpinner;
  const intervalMs = (flowData.interval ?? 5) * 1000;
  const deadline = Date.now() + (flowData.expires_in ?? 1800) * 1000;

  while (Date.now() < deadline && !cancelled) {
    await sleep(intervalMs, abortCtrl.signal);
    if (cancelled) break;

    try {
      const res = await fetch(`${baseUrl}/v1/wallet/oauth/gate/device/poll`, {
        method: "POST",
        headers: {
          ...clientHeaders(),
          "Content-Type": "application/json",
          "x-gtweb3-device-token": getOrCreateDeviceToken(),
          "x-gtweb3-app-id": getBwAppId(),
          "source": "3",
        },
        body: JSON.stringify({ flow_id: flowData.flow_id }),
      });

      if (!res.ok) continue;

      const poll = (await res.json()) as DevicePollResponse;

      if (poll.status === "ok") {
        if (poll.mcp_token) {
          process.removeListener("SIGINT", cleanupAndExit);
          cleanupCtrlCWatcher();
          pollSpinner.succeed("Gate login successful!");

          saveAuth({
            mcp_token: poll.mcp_token,
            provider: "gate",
            user_id: poll.user_id,
            account_id: poll.account_id,
            evm_address: poll.evm_address,
            sol_address: poll.sol_address,
            expires_at: poll.expires_in
              ? Date.now() + poll.expires_in * 1000
              : Date.now() + 30 * 86_400_000,
            env: "default",
          });

          console.log();
          if (poll.user_id)
            console.log(chalk.green(`  User ID: ${poll.user_id}`));
          if (poll.wallet_address)
            console.log(chalk.green(`  Wallet: ${poll.wallet_address}`));
          console.log(chalk.green(`  Provider: Gate`));
          console.log(chalk.gray(`  Token saved to ${getAuthFilePath()}`));

          return;
        }
      }

      if (poll.status === "error") {
        process.removeListener("SIGINT", cleanupAndExit);
        cleanupCtrlCWatcher();
        pollSpinner.fail(`Gate login failed: ${poll.error ?? "Unknown error"}`);
        return;
      }
    } catch {
      // poll 失败，继续轮询
    }
  }

  process.removeListener("SIGINT", cleanupAndExit);
  cleanupCtrlCWatcher();
  pollSpinner.fail(cancelled ? "Login cancelled" : "Login timed out");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}


