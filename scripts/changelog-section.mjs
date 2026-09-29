#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抽出指定版本的小节，供 CI 填进 GitHub Release 的说明。
 *
 * 用法：
 *   node scripts/changelog-section.mjs 0.1.0    打印该版本的正文
 *   node scripts/changelog-section.mjs --help   列出 CHANGELOG.md 里现有的版本
 *
 * 定位规则：标题行形如 `## [0.1.0]` 或 `## [0.1.0] - 2026-09-29`（版本号是方括号里那串），
 * 正文一直取到下一个 `## ` 标题或文件末尾。
 *
 * ⚠️ 抽不到时**不报错**：打印兜底文案并以 0 退出。
 * 发版流程不该因为忘了写日志就被挡住；而那句兜底会明晃晃地出现在 Release 与客户端
 * 的更新说明里，比构建失败更容易被注意到。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = join(rootDir, "CHANGELOG.md");

/** 抽不到小节时的兜底说明（也是历史版本一直在用的那句话） */
const FALLBACK =
  "安装包见下方 Assets。已安装旧版本的用户可直接在「设置 → 软件」中一键升级。";

const argv = process.argv.slice(2);
// 版本号 = 第一个不以 - 开头的参数（同 set-version / wait-release 的取法）
const version = argv.find((a) => !a.startsWith("-"));

/** 解析出所有版本小节，按文件里出现的顺序返回 */
function readSections(raw) {
  const out = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^##\s+\[([^\]]+)\]/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { version: m[1].trim(), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ version: s.version, body: s.lines.join("\n").trim() }));
}

function usage(list) {
  console.log(`
用法：
  node scripts/changelog-section.mjs <版本号>    打印该版本的正文

CHANGELOG.md 里现有的版本：${list.length ? list.join("、") : "（一个都没有）"}
`);
}

let raw = "";
try {
  raw = readFileSync(changelogPath, "utf8");
} catch {
  console.error("! 读不到 CHANGELOG.md，改用兜底说明");
  console.log(FALLBACK);
  process.exit(0);
}

const sections = readSections(raw);

if (argv.includes("--help") || argv.includes("-h")) {
  usage(sections.map((s) => s.version));
  process.exit(0);
}
if (!version) {
  usage(sections.map((s) => s.version));
  process.exit(1);
}

const hit = sections.find((s) => s.version === version);
if (!hit || !hit.body) {
  console.error(
    `! CHANGELOG.md 里没有 [${version}] 这一节（或正文为空），改用兜底说明`,
  );
  console.log(FALLBACK);
  process.exit(0);
}

console.log(hit.body);
