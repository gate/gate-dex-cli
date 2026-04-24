#!/usr/bin/env node
/**
 * Build self-contained binaries for gate-dex-cli via `bun build --compile`.
 *
 * Production mode (default):
 *   - Does NOT bake any .env values. Env is provided at runtime via GateClaw Web form
 *     (injected by OpenClaw runtime into process.env) or via --env-file at user side.
 *   - Targets Linux x64 by default (required by GateClaw Pod).
 *
 * Local-test mode (--bake-env):
 *   - Reads root .env and bakes all vars into the binary (useful for quick local testing
 *     against the test environment without relying on shell env).
 *
 * Usage:
 *   node scripts/build-binary.mjs
 *   node scripts/build-binary.mjs --target bun-linux-x64,bun-darwin-arm64
 *   node scripts/build-binary.mjs --all
 *   node scripts/build-binary.mjs --bake-env
 *   node scripts/build-binary.mjs --bake-env --env-file /path/to/.env
 *
 * Output naming:
 *   dist/gate-dex-<platform>-<arch>   e.g. dist/gate-dex-linux-x64
 */

import { execSync } from "child_process";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, "..");
const rootDir = join(cliDir, "..");

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const hasFlag = (name) => args.includes(name);

const ALL_TARGETS = ["bun-linux-x64", "bun-darwin-arm64"];
const DEFAULT_TARGETS = ["bun-linux-x64"];

const targets = hasFlag("--all")
  ? ALL_TARGETS
  : argVal("--target")
    ? argVal("--target").split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_TARGETS;

const bakeEnv = hasFlag("--bake-env");
const envFilePath = argVal("--env-file")
  ? resolve(argVal("--env-file"))
  : join(rootDir, ".env");

// ── Load env (only if baking) ─────────────────────────────────────────────────
let envVars = {};
if (bakeEnv) {
  if (existsSync(envFilePath)) {
    const raw = readFileSync(envFilePath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      envVars[key] = value;
    }
    console.log(`[env] Baking ${Object.keys(envVars).length} vars from ${envFilePath}`);
    for (const [k, v] of Object.entries(envVars)) {
      console.log(`      ${k}=${v}`);
    }
  } else {
    console.warn(`[env] --bake-env requested but ${envFilePath} not found; no env will be baked`);
  }
} else {
  console.log(`[env] Skipped (production mode — env injected at runtime by GateClaw / shell)`);
}

// ── Package metadata ──────────────────────────────────────────────────────────
const pkgJson = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf-8"));

// ── Build --define flags ──────────────────────────────────────────────────────
// Encode env vars as base64 JSON (empty string when not baking — explicitly replaces
// the identifier so runtime doesn't accidentally pick up a shell var of the same name).
const envB64 = bakeEnv
  ? Buffer.from(JSON.stringify(envVars)).toString("base64")
  : "";

const defines = [
  `--define 'process.env.BUNDLED_ENV_B64="${envB64}"'`,
  `--define 'process.env.BUNDLED_PKG_NAME="${pkgJson.name}"'`,
  `--define 'process.env.BUNDLED_PKG_VERSION="${pkgJson.version}"'`,
].join(" ");

// ── Build each target ─────────────────────────────────────────────────────────
const distDir = join(cliDir, "dist");
mkdirSync(distDir, { recursive: true });

const entryPoint = join(cliDir, "src/cli/binary-entry.ts");

function targetToSuffix(t) {
  // bun-linux-x64 -> linux-x64, bun-darwin-arm64 -> darwin-arm64
  return t.replace(/^bun-/, "");
}

for (const target of targets) {
  const outFile = join(distDir, `gate-dex-${targetToSuffix(target)}`);
  const cmd = `bun build ${entryPoint} --compile --target=${target} --outfile ${outFile} ${defines}`;

  console.log(`\n[build] target=${target} → ${outFile}`);
  execSync(cmd, { cwd: cliDir, stdio: "inherit" });
}

console.log(`\n✅ Done. Outputs in ${distDir}/`);
for (const t of targets) {
  console.log(`   gate-dex-${targetToSuffix(t)}`);
}
