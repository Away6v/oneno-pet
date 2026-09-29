#!/usr/bin/env node
/**
 * 版本号同步：以 src-tauri/tauri.conf.json 的 version 为唯一权威，
 * 反写到 package.json、src-tauri/Cargo.toml（以及 Cargo.lock），避免各处各自声明后漂移。
 *
 * 前端不再硬编码版本号（改用 Tauri 的 getVersion() 读取），所以只需管这几个文件。
 *
 * 用法：
 *   node scripts/sync-version.mjs           同步（不一致才写盘）
 *   node scripts/sync-version.mjs --check   只校验，不一致则以非 0 退出（供 CI 使用）
 *
 * 想「直接输入一个新版本号、一次性改完」，用 scripts/set-version.mjs（npm run set-version）。
 * 两个脚本共用 scripts/version-files.mjs 里的读写逻辑。
 */
import { checkConsistency, readAuthority, SEMVER, writeDerived } from "./version-files.mjs";

const checkOnly = process.argv.includes("--check");

const version = readAuthority();
if (!SEMVER.test(version)) {
  console.error(`tauri.conf.json 的 version 不是合法语义化版本：${version}`);
  process.exit(1);
}

const { mismatched } = checkConsistency();

if (mismatched.length === 0) {
  console.log(`版本号已一致：${version}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`版本号不一致（以 tauri.conf.json 的 ${version} 为准）：`);
  for (const m of mismatched) console.error(`  - ${m}`);
  process.exit(1);
}

for (const c of writeDerived(version)) {
  if (c.skipped) {
    console.error(`  ! ${c.file} 里没找到版本号字段，已跳过`);
  } else if (c.from !== c.to) {
    console.log(`${c.file}：${c.from} → ${c.to}`);
  }
}
console.log(`版本号已同步为 ${version}`);
