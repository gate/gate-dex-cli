// Build-time entry point for standalone binary.
// BUNDLED_ENV_B64 and BUNDLED_PKG_* are injected via bun --define at build time (dot notation only).
// We decode and apply them to process.env before loading the main module.

// 1. Inject all env vars from the baked-in base64 blob
const envB64 = process.env.BUNDLED_ENV_B64;
if (envB64) {
  const envMap = JSON.parse(atob(envB64)) as Record<string, string>;
  for (const [k, v] of Object.entries(envMap)) {
    process.env[k] = v;
  }
}

// 2. Provide package metadata so index.ts skips the readFileSync(package.json) call
(globalThis as any).__BUNDLED_PKG__ = {
  name: process.env.BUNDLED_PKG_NAME ?? "gate-wallet-cli",
  version: process.env.BUNDLED_PKG_VERSION ?? "dev",
};

// 3. Dynamic import so top-level code above runs BEFORE index.ts initializes
await import("./index.ts");
