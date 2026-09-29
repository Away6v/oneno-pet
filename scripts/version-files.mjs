/**
 * 版本号读写的公共逻辑，供 sync-version.mjs 与 set-version.mjs 共用。
 *
 * 版本号分布（src-tauri/tauri.conf.json 是唯一权威）：
 *   src-tauri/tauri.conf.json   ← 权威
 *   package.json                ← 反写
 *   src-tauri/Cargo.toml        ← 反写
 *   src-tauri/Cargo.lock        ← 反写（cargo 构建时也会自己更新，提前改掉能让 git 工作区立刻干净）
 *
 * 这里一律用「首个匹配 + 字符串替换」而不是 JSON.parse + stringify，
 * 目的是保住原文件的排版与换行符，避免产生整文件级别的 diff 噪音。
 * 前提：四个文件里被替换的那个字段都只出现一次（已确认）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  conf: join(rootDir, "src-tauri", "tauri.conf.json"),
  pkg: join(rootDir, "package.json"),
  cargo: join(rootDir, "src-tauri", "Cargo.toml"),
  lock: join(rootDir, "src-tauri", "Cargo.lock"),
};

/** 语义化版本：三段数字，可选 -beta.1 / +build 后缀 */
export const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const confRe = /("version"\s*:\s*")([^"]*)(")/;
const pkgRe = /("version"\s*:\s*")([^"]*)(")/;
// 只认 [package] 段内、位于行首的 version；依赖行（`tauri-build = { version = "2" }`）不在行首，不会误伤
const cargoRe = /(\[package\][\s\S]*?^version\s*=\s*")([^"]*)(")/m;
// Cargo.lock 里 name 紧跟 [[package]]，按这个结构精确定位本项目条目
const lockRe = /(\[\[package\]\]\r?\nname = "oneno-pet"\r?\nversion = ")([^"]*)(")/;

function readMatch(path, re) {
  const raw = readFileSync(path, "utf8");
  const m = re.exec(raw);
  return { raw, match: m, value: m ? m[2] : null };
}

/** tauri.conf.json 里的版本号（唯一权威）。取不到直接抛错，调用方不用自己判空。 */
export function readAuthority() {
  const { value } = readMatch(paths.conf, confRe);
  if (value === null) {
    throw new Error("没在 src-tauri/tauri.conf.json 里找到 version 字段");
  }
  return value;
}

/** 四个文件当前的版本号；取不到的字段为 null（Cargo.lock 可能还没生成） */
export function readVersions() {
  return {
    conf: readMatch(paths.conf, confRe).value,
    pkg: readMatch(paths.pkg, pkgRe).value,
    cargo: readMatch(paths.cargo, cargoRe).value,
    lock: readMatch(paths.lock, lockRe).value,
  };
}

/** 写 tauri.conf.json（权威）。返回 { from, to }。 */
export function writeAuthority(version) {
  const { raw, match, value } = readMatch(paths.conf, confRe);
  if (value === null) throw new Error("没在 src-tauri/tauri.conf.json 里找到 version 字段");
  const next = raw.replace(confRe, `$1${version}$3`);
  if (next === raw && value !== version) {
    throw new Error("tauri.conf.json 的版本号替换没有生效，请检查文件格式");
  }
  if (next !== raw) writeFileSync(paths.conf, next);
  return { from: value, to: version };
}

/**
 * 把版本号反写到 package.json / Cargo.toml / Cargo.lock。
 * 返回改动清单；内容本来就对的条目不会写盘（from === to 时跳过）。
 */
export function writeDerived(version) {
  const changes = [];
  const targets = [
    { key: "pkg", file: "package.json", path: paths.pkg, re: pkgRe },
    { key: "cargo", file: "src-tauri/Cargo.toml", path: paths.cargo, re: cargoRe },
    { key: "lock", file: "src-tauri/Cargo.lock", path: paths.lock, re: lockRe },
  ];
  for (const t of targets) {
    const { raw, match, value } = readMatch(t.path, t.re);
    if (value === null) {
      changes.push({ file: t.file, from: null, to: version, skipped: true });
      continue;
    }
    if (value !== version) {
      writeFileSync(t.path, raw.replace(t.re, `$1${version}$3`));
    }
    changes.push({ file: t.file, from: value, to: version, skipped: false });
  }
  return changes;
}

/**
 * 校验 package.json / Cargo.toml 是否与权威版本一致。
 * 故意不含 Cargo.lock —— 它由 cargo 自动维护，不该拦住发版。
 * 返回不一致的描述数组，空数组表示一致。
 */
export function checkConsistency() {
  const authority = readAuthority();
  const { pkg, cargo } = readVersions();
  const mismatched = [];
  if (pkg !== authority) mismatched.push(`package.json → ${pkg}`);
  if (cargo !== authority) mismatched.push(`Cargo.toml → ${cargo}`);
  return { authority, mismatched };
}
