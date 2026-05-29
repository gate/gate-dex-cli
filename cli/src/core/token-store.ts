/**
 * Token 持久化 - 保存/读取 mcp_token 到 ~/.gate-dex/auth.json
 * 避免每次 CLI 启动都需要重新登录
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export interface StoredAuth {
  mcp_token: string;
  provider: "gate" | "google";
  user_id?: string | undefined;
  /** BW account_id（poll 响应下发，用于 gateway 操作） */
  account_id?: string | undefined;
  /** BW EVM 钱包地址（poll 响应下发，避免调 getAddresses） */
  evm_address?: string | undefined;
  /** BW SOL 钱包地址（poll 响应下发） */
  sol_address?: string | undefined;
  expires_at?: number | undefined;
  env: string;
  server_url?: string;
}

export function getBwAccessToken(auth: StoredAuth): string {
  return auth.mcp_token;
}

/**
 * 返回 auth 存储目录。
 * 优先级：--auth-dir CLI 选项（通过 GATE_DEX_HOME env）> ~/.gate-dex
 */
export function getAuthDir(): string {
  return process.env["GATE_DEX_HOME"] ?? join(homedir(), ".gate-dex");
}

function getAuthFile(): string {
  return process.env["GATE_DEX_AUTH_FILE"] ?? join(getAuthDir(), "auth.json");
}

function getDeviceFile(): string {
  return join(getAuthDir(), "device.json");
}

export function saveAuth(auth: StoredAuth): void {
  const dir = getAuthDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getAuthFile(), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export function loadAuth(env?: string): StoredAuth | null {
  try {
    const file = getAuthFile();
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf-8")) as StoredAuth;

    if (data.expires_at && Date.now() >= data.expires_at) {
      clearAuth();
      return null;
    }

    if (env && data.env !== env) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

export function clearAuth(): void {
  try {
    unlinkSync(getAuthFile());
  } catch {
    // ignore
  }
}

export function getAuthFilePath(): string {
  return getAuthFile();
}

/**
 * 获取或生成稳定的设备指纹 token（首次生成后持久化到 ~/.gate-dex/device.json）
 * 用于 GV API 的 x-gtweb3-device-token 请求头
 */
export function getOrCreateDeviceToken(): string {
  const deviceFile = getDeviceFile();
  try {
    if (existsSync(deviceFile)) {
      const data = JSON.parse(readFileSync(deviceFile, "utf-8")) as {
        device_token?: string;
      };
      if (data.device_token) return data.device_token;
    }
  } catch {
    // 读取失败则重新生成
  }
  mkdirSync(getAuthDir(), { recursive: true });
  const token = randomBytes(20).toString("hex"); // 40 位 hex 字符串
  writeFileSync(
    deviceFile,
    JSON.stringify({ device_token: token }, null, 2),
    { mode: 0o600 },
  );
  return token;
}
