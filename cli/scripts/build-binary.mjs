#!/usr/bin/env node
/**
 * Build a self-contained binary for gate-wallet-cli using bun compile.
 *
 * Steps:
 *   1. Read env vars from root .env
 *   2. Base64-encode all env vars into a single --define (avoids bracket-notation issue)
 *   3. bun build --compile → dist/gate-wallet
 *
 * Usage:
 *   node scripts/build-binary.mjs [--env-file <path>]
 *
 * Defaults:
 *   --env-file  ../../.env   (root .env relative to this cli/ dir)
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, "..");
const rootDir = join(cliDir, "..");

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const envFileIdx = args.indexOf("--env-file");
const envFilePath = envFileIdx !== -1 ? resolve(args[envFileIdx + 1]) : join(rootDir, ".env");

// ── Read .env ─────────────────────────────────────────────────────────────────
const envVars = {};
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
  console.log(`[env] Loaded ${Object.keys(envVars).length} vars from ${envFilePath}`);
  for (const [k, v] of Object.entries(envVars)) {
    console.log(`      ${k}=${v}`);
  }
} else {
  console.warn(`[env] .env not found at ${envFilePath}, no env injection`);
}

// ── Read package.json ─────────────────────────────────────────────────────────
const pkgJson = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf-8"));

// ── Encode env vars as base64 JSON (safe to embed in a JS string literal) ────
// bun --define only replaces dot-notation process.env.KEY, not bracket process.env["KEY"].
// So we encode all vars into one blob and decode them at runtime in binary-entry.ts.
const envB64 = Buffer.from(JSON.stringify(envVars)).toString("base64");

// ── Build defines ─────────────────────────────────────────────────────────────
const defines = [
  `--define 'process.env.BUNDLED_ENV_B64="${envB64}"'`,
  `--define 'process.env.BUNDLED_PKG_NAME="${pkgJson.name}"'`,
  `--define 'process.env.BUNDLED_PKG_VERSION="${pkgJson.version}"'`,
].join(" ");

// ── Build ─────────────────────────────────────────────────────────────────────
const outFile = join(cliDir, "dist/gate-wallet");
const entryPoint = join(cliDir, "src/cli/binary-entry.ts");

const cmd = `bun build ${entryPoint} --compile --outfile ${outFile} ${defines}`;

console.log(`\n[build] Compiling with bun...`);
console.log(`        entry:  src/cli/binary-entry.ts`);
console.log(`        output: dist/gate-wallet\n`);

execSync(cmd, { cwd: cliDir, stdio: "inherit" });

console.log(`\n✅ Binary ready: dist/gate-wallet`);
console.log(`   Test it:  ./dist/gate-wallet --version`);
console.log(`             ./dist/gate-wallet login`);
