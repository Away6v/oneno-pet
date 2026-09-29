#!/usr/bin/env node
/**
 * 本地打包（桌面端）。
 *
 * 为什么需要它：开启 bundle.createUpdaterArtifacts 后，tauri build 会强制要求签名私钥，
 * 未设置 TAURI_SIGNING_PRIVATE_KEY 时直接报
 * 「A public key has been found, but no private key. Make sure to set `TAURI_SIGNING_PRIVATE_KEY`」。
 * 本脚本自动从 ~/.tauri/oneno-pet.key 读私钥并注入，省去每次手动 export。
 *
 * 用法：
 *   npm run build:desktop                 等价于 tauri build（自动带签名）
 *   npm run build:desktop -- --no-bundle  额外参数会透传给 tauri build
 *   npm run build:desktop -- --no-sign    跳过签名（本地快速验证用，产不出升级包）
 *
 * 私钥不在默认位置时，用环境变量 ONENO_SIGNING_KEY 指定私钥文件路径。
 * 已经手动设了 TAURI_SIGNING_PRIVATE_KEY 时，本脚本不干预。
 *
 * 两个必须踩过的坑（本机 CLI 2.11.5 实测）：
 * 1) 只设 TAURI_SIGNING_PRIVATE_KEY_PATH 不生效，打包末尾照样报「no private key」，
 *    必须把私钥内容填进 TAURI_SIGNING_PRIVATE_KEY（官方文档写法）。
 * 2) 不设 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 时，CLI 看到 stdin 是终端就会
 *    停下来等输入密码（日志：Decrypting updater signing key, expect a prompt for password），
 *    在 CI / 后台进程里表现为「卡死」。所以这里默认显式给一个空密码。
 *    私钥若真的带密码，自己 export TAURI_SIGNING_PRIVATE_KEY_PASSWORD 覆盖即可。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keyPath =
  process.env.ONENO_SIGNING_KEY ||
  join(homedir(), ".tauri", "oneno-pet.key");

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(keyPath)) {
    console.error(`[build] 找不到签名私钥：${keyPath}`);
    console.error(
      "[build] 请先生成：npx tauri signer generate -w ~/.tauri/oneno-pet.key",
    );
    console.error("[build] 或用 ONENO_SIGNING_KEY 指定私钥文件路径。");
    process.exit(1);
  }
  const key = readFileSync(keyPath, "utf8").trim();
  if (!key) {
    console.error(`[build] 私钥文件是空的：${keyPath}`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = key;
  // 顺手也填上，兼容认这个变量的版本
  env.TAURI_SIGNING_PRIVATE_KEY_PATH = keyPath;
  console.log(`[build] 已注入签名私钥（${key.length} 字符，来自 ${keyPath}）`);
}

// 没给密码就补一个空密码，避免 CLI 停在交互式密码提示上（后台跑会直接卡死）
if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  console.log("[build] 私钥密码：空（未设置 TAURI_SIGNING_PRIVATE_KEY_PASSWORD）");
}

// 直接用 node_modules/.bin 下的 CLI，避免依赖 npm script 的 PATH 注入
const bin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const result = spawnSync(bin, ["build", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(`[build] 启动 tauri 失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
