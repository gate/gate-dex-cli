/**
 * MCP URL / server URL helpers
 * MCP SDK 依赖已移除；仅保留 getServerUrl() 用于推导 GV API 环境
 */

/** 未配置 MCP_URL 时的默认服务地址（生产） */
export const DEFAULT_MCP_SERVER_URL =
  "https://wallet-service-mcp-prod.gateweb3.cc/mcp";

export function getServerUrl(): string {
  return process.env["MCP_URL"] ?? DEFAULT_MCP_SERVER_URL;
}

/**
 * 从 MCP_URL 推导出 REST baseUrl（去掉末尾 `/mcp`）。
 */
export function getMcpBaseUrl(): string {
  return getServerUrl().replace(/\/mcp$/, "");
}
