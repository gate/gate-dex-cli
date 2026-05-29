// E2E test runner — 加载 CLI 前可选地把 AI 网关域名 pin 到一个可达 IP。
//
// 背景：测试环境 AI 网关的 NLB 跨 AZ 健康度不稳，DNS 偶尔解析到不可达的公网 IP，
// 导致 Node fetch 偶发 connect timeout。设置 GATE_DEX_PIN_HOST + GATE_DEX_PIN_IP
// 后，本 runner 把该域名的 dns.lookup 固定到指定 IP；不设则用系统默认解析（no-op）。
// 网关 NLB 路由修好后，e2e-test.sh 不再注入这两个变量，本文件即纯透传。
import dns from "node:dns";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pinHost = process.env.GATE_DEX_PIN_HOST;
const pinIp = process.env.GATE_DEX_PIN_IP;

if (pinHost && pinIp) {
  const realLookup = dns.lookup.bind(dns);
  dns.lookup = function (hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (hostname === pinHost) {
      if (options && options.all) return callback(null, [{ address: pinIp, family: 4 }]);
      return callback(null, pinIp, 4);
    }
    return realLookup(hostname, options, callback);
  };
}

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, "..", "src", "cli", "index.ts"));
