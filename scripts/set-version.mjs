#!/usr/bin/env node
/**
 * 一键改版本号：给一个版本号，自动把需要改的地方全改掉。
 *
 * 用法：
 *   npm run set-version -- 0.1.2              直接给版本号
 *   npm run set-version                       交互式输入
 *   npm run set-version -- 0.1.2 --dry-run    只看会改什么，不落盘
 *   npm run set-version -- 0.1.0 --force      允许把版本号调低（默认拒绝）
 *
 * 改动范围（src-tauri/tauri.conf.json 是唯一权威，其余都由它反写）：
 *   src-tauri/tauri.conf.json   ← 权威来源
 *   package.json                ← 反写
 *   src-tauri/Cargo.toml        ← 反写
 *   src-tauri/Cargo.lock        ← 反写（cargo 构建时也会自己更新，提前改掉能让 git 工作区立刻干净）
 *
 * 本脚本**只改文件，不碰 git**：提交、打 tag、推送都由你自己来，最后会打印该敲的命令。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  checkConsistency,
  readAuthority,
  readVersions,
  rootDir,
  SEMVER,
  writeAuthority,
  writeDerived,
} from "./version-files.mjs";

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function usage() {
  console.log(`
用法：
  npm run set-version -- 0.1.2              直接给版本号
  npm run set-version                       交互式输入
  npm run set-version -- 0.1.2 --dry-run    只看会改什么，不落盘
  npm run set-version -- 0.1.0 --force      允许把版本号调低（默认拒绝）

会改这四处：tauri.conf.json / package.json / Cargo.toml / Cargo.lock
本脚本不碰 git，提交与打 tag 由你自己来。
`);
}

/** 只比较前三段数字，忽略 -beta.1 这类后缀 */
function compareSemver(a, b) {
  const pa = a.split(/[-+]/)[0].split(".").map(Number);
  const pb = b.split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * 取 git remote 名（本仓库叫 oneno-pet 而不是 origin，所以不能写死）。
 * 直接读 .git/config 而不调 git 命令：少一次进程，也不受 PATH / 沙箱限制影响。
 * 拿不到就退回占位符，不影响改版本号这件正事。
 */
function detectRemote() {
  try {
    const dotGit = join(rootDir, ".git");
    if (!existsSync(dotGit)) return "<remote>";
    let configPath = join(dotGit, "config");
    if (!existsSync(configPath)) {
      // .git 是文件时（worktree / submodule）里面写着 gitdir: <路径>
      const ptr = readFileSync(dotGit, "utf8");
      const m = /^gitdir:\s*(.+)$/m.exec(ptr);
      if (!m) return "<remote>";
      const dir = isAbsolute(m[1].trim()) ? m[1].trim() : join(rootDir, m[1].trim());
      configPath = join(dir, "config");
    }
    const cfg = readFileSync(configPath, "utf8");
    const names = [...cfg.matchAll(/^\s*\[remote\s+"([^"]+)"\]/gm)].map((x) => x[1]);
    if (names.length === 0) return "<remote>";
    return names.includes("origin") ? "origin" : names[0];
  } catch {
    return "<remote>";
  }
}

// ── 参数 ────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  usage();
  process.exit(0);
}
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const argVersion = argv.find((a) => !a.startsWith("-"));

// ── 1. 当前版本 ─────────────────────────────────
let current;
try {
  current = readAuthority();
} catch (e) {
  fail(e.message);
}

// ── 2. 目标版本 ─────────────────────────────────
let next = argVersion;
if (!next) {
  if (!process.stdin.isTTY) {
    console.error("✖ 没给版本号，而且当前不是交互式终端。");
    usage();
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  next = (await rl.question(`当前版本 v${current}，请输入新版本号：`)).trim();
  rl.close();
}

// ── 3. 校验 ─────────────────────────────────────
if (!SEMVER.test(next)) {
  fail(`「${next}」不是合法版本号，要形如 0.1.2（可带 -beta.1 这类后缀）`);
}
if (next === current) {
  console.log(`\n版本号已经是 v${current}，无需改动。\n`);
  process.exit(0);
}
if (compareSemver(next, current) < 0 && !force) {
  console.error(`\n✖ 拒绝：新版本 v${next} 低于当前 v${current}。`);
  console.error("  更新器只认更高的版本号，降级会让已发布的客户端永远收不到更新。");
  console.error("  确实要降级请加 --force。\n");
  process.exit(1);
}
if (next.includes("-")) {
  console.warn(
    `⚠ ${next} 带预发布后缀：更新器按 semver 比较，预发布版本低于同号正式版，客户端可能不认。\n`,
  );
}

// ── 4. 预览 ─────────────────────────────────────
const before = readVersions();
const rows = [
  ["src-tauri/tauri.conf.json", before.conf],
  ["package.json", before.pkg],
  ["src-tauri/Cargo.toml", before.cargo],
  ["src-tauri/Cargo.lock", before.lock],
];

console.log(`\n版本号  v${current} → v${next}${dryRun ? "   （--dry-run，不落盘）" : ""}\n`);
for (const [file, from] of rows) {
  console.log(`  ${file.padEnd(28)} ${from ?? "（无此字段，跳过）"} → ${from ? next : "-"}`);
}

if (dryRun) {
  console.log("\n（--dry-run 结束，什么都没改）\n");
  process.exit(0);
}

// ── 5. 落盘 ─────────────────────────────────────
console.log("");
writeAuthority(next);
for (const c of writeDerived(next)) {
  if (c.skipped) {
    console.log(`  ! ${c.file} 里没找到版本号字段，已跳过`);
  } else if (c.from !== c.to) {
    console.log(`  ✓ ${c.file}  ${c.from} → ${c.to}`);
  } else {
    console.log(`  · ${c.file}  已经是 ${next}`);
  }
}

// ── 6. 收尾校验 ─────────────────────────────────
const { mismatched } = checkConsistency();
if (mismatched.length > 0) {
  console.error("\n✖ 收尾校验没过，以下文件与权威版本不一致：");
  for (const m of mismatched) console.error(`  - ${m}`);
  console.error("");
  process.exit(1);
}
console.log("  ✓ 校验通过：tauri.conf.json / package.json / Cargo.toml 三处一致");

// ── 7. 下一步（本脚本不碰 git）──────────────────
const remote = detectRemote();
console.log(`
────────────────────────────────────────────────
下一步（由你自己执行，脚本不会碰 git）：

  git add -A && git commit -m "chore: 版本号 ${next}"
  git push ${remote} main
  git tag v${next}
  git push ${remote} v${next}

推完 tag 后 CI 会自动构建（约 7 分钟）。
等 CI 变绿 → 到 Releases 页面确认 Assets 有 3 个产物 → 点 Publish release。
⚠ tag 名必须正好是 v${next}，与版本号对不上 CI 会直接失败。
`);
