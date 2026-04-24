#!/usr/bin/env node

/**
 * preuninstall hook — 卸载时清理用户目录下的配置文件
 *   ~/.gate-dex/       (auth.json)
 */

const { rmSync, existsSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");

const dirs = [
  join(homedir(), ".gate-dex"),
];

for (const dir of dirs) {
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      console.log("[gate-dex] removed " + dir);
    } catch (e) {
      console.warn("[gate-dex] failed to remove " + dir);
    }
  }
}
