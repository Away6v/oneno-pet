#!/usr/bin/env node
/**
 * 盯着 tag 触发的 GitHub Actions 构建，直到它跑完 —— 不用一直刷网页。
 *
 * 用法：
 *   npm run wait-release                     盯最新一次 tag 构建
 *   npm run wait-release -- v0.1.2           盯指定 tag
 *   npm run wait-release -- --once           只看一眼当前状态，不等
 *   npm run wait-release -- --timeout 1200   最长等 20 分钟（默认 15 分钟）
 *   npm run wait-release -- --token <令牌>   用令牌调 API（配额 60/小时 → 5000/小时）
 *
 * 结束时会顺带告诉你「能不能去点 Publish release 了」：
 *   - CI 绿 + 还没发布 → 可以点 Publish 了
 *   - CI 绿 + 已发布   → latest.json 已切换，客户端能查到
 *   - CI 红            → 打印失败步骤
 *
 * 为什么需要它：tag 一推「标签页」立刻就有，但「发行版页」要等 tauri-action
 * 把草稿建出来才有内容，中间 7~8 分钟什么都没有 —— 很容易误判成配置错了。
 *
 * ⚠️ 匿名调 GitHub API 每小时只有 60 次，而一轮「等 CI」就要用掉约 30 次 ——
 *    同小时内排查两三次就会耗光。所以本脚本是「配额感知」的：
 *    启动先探一次配额（/rate_limit 不计入配额），运行中按剩余量自动降频；
 *    真耗尽了要么等到重置，要么给令牌（--token / GITHUB_TOKEN / GH_TOKEN）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";

/** 轮询节奏：状态查得勤、步骤查得疏（省配额）。配额紧张时会自动降频，见 pollInterval() */
const POLL_MS = 15000;
const STEPS_EVERY = 3; // 每 3 轮才拉一次步骤详情
const FIND_RUN_TIMEOUT_MS = 90000; // 推 tag 后 run 要几秒才出现，给它 90 秒

/**
 * 匿名调 GitHub API 每小时只有 60 次，而一轮「等 CI」就要用掉 30 次左右 ——
 * 排查几次就把配额烧光，连脚本自己都跑不起来。所以要先知道剩多少再决定查多勤。
 * /rate_limit 这个端点**本身不计入配额**，启动时探一次是免费的。
 */
const quota = { limit: null, remaining: null, reset: null };
let actionsUrl = "https://github.com/<owner>/<repo>/actions";

const argv = process.argv.slice(2);
const tokenArgIndex = argv.indexOf("--token");
const tokenArg = tokenArgIndex >= 0 ? argv[tokenArgIndex + 1] : undefined;
/** 令牌优先级：--token 参数 > GITHUB_TOKEN > GH_TOKEN */
const token = tokenArg || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

function fail(msg, code = 1) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(code);
}

/** 配额不够时的三条自救路径 —— 直接打印在报错里，省得再去翻文档 */
function quotaHint() {
  const lines = [];
  if (quota.reset) {
    const mins = Math.max(1, Math.ceil((quota.reset - Date.now()) / 60000));
    lines.push(`  ① 等约 ${mins} 分钟（配额在 ${new Date(quota.reset).toLocaleTimeString("zh-CN")} 重置）`);
  }
  lines.push(
    "  ② 给脚本一个令牌，配额从 60/小时 提到 5000/小时：",
    "       npm run wait-release -- v0.1.2 --token <你的令牌>",
    "     或设环境变量 GITHUB_TOKEN / GH_TOKEN",
    "     （公开仓库只读，令牌不需要勾任何 scope）",
  );
  lines.push(`  ③ 直接开网页看：${actionsUrl}`);
  return lines.join("\n");
}

function usage() {
  console.log(`
用法：
  npm run wait-release                       盯最新一次 tag 构建
  npm run wait-release -- v0.1.2             盯指定 tag
  npm run wait-release -- --once             只看一眼当前状态，不等
  npm run wait-release -- --timeout 1200     最长等 20 分钟（默认 15 分钟）
  npm run wait-release -- --token <令牌>     用令牌调 API（配额 60/小时 → 5000/小时）

环境变量：GITHUB_TOKEN / GH_TOKEN —— 效果同 --token

⚠️ 匿名配额只有 60 次/小时，一轮「等 CI」约用 30 次。
   配额紧张时脚本会自动降频（15s → 30s → 60s）并停止拉步骤详情；
   若启动时就已耗尽，会等到重置再继续（前提是重置时间在 --timeout 之内）。
`);
}

/**
 * 从 .git/config 里解析出 owner / repo。
 * 直接读文件而不调 git 命令：少一次进程，也不受 PATH 与沙箱限制影响。
 * 支持 https://github.com/o/r.git 与 git@github.com:o/r.git 两种写法。
 */
function detectRepo() {
  const dotGit = join(rootDir, ".git");
  if (!existsSync(dotGit)) return null;
  let configPath = join(dotGit, "config");
  if (!existsSync(configPath)) {
    // .git 是文件时（worktree / submodule）里面写着 gitdir: <路径>
    const ptr = readFileSync(dotGit, "utf8");
    const m = /^gitdir:\s*(.+)$/m.exec(ptr);
    if (!m) return null;
    const dir = isAbsolute(m[1].trim()) ? m[1].trim() : join(rootDir, m[1].trim());
    configPath = join(dir, "config");
  }
  const cfg = readFileSync(configPath, "utf8");
  // 取第一个 remote 的 url
  const m = /\[remote\s+"[^"]+"\][\s\S]*?^\s*url\s*=\s*(.+)$/m.exec(cfg);
  if (!m) return null;
  const url = m[1].trim();
  const g = /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  return g ? { owner: g[1], repo: g[2] } : null;
}

async function api(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "oneno-pet-wait-release" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { headers });

  // 每个响应都自带配额头，顺手记下来给 pollInterval() 用 —— 不用为此多发一个请求
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null) quota.remaining = Number(remaining);
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset) quota.reset = Number(reset) * 1000;
  const limit = res.headers.get("x-ratelimit-limit");
  if (limit) quota.limit = Number(limit);

  if ((res.status === 403 || res.status === 429) && quota.remaining === 0) {
    throw new Error(`GitHub API 配额用完了（上限 ${quota.limit}/小时）。\n${quotaHint()}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status}：${path}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 启动时探一次配额。/rate_limit 不计入配额，所以这步免费。
 * 探不到（网络问题等）就静默跳过，后面按默认节奏走。
 */
async function preflightQuota() {
  try {
    const res = await fetch(`${API}/rate_limit`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "oneno-pet-wait-release" },
    });
    if (!res.ok) return;
    const core = (await res.json())?.resources?.core;
    if (!core) return;
    quota.limit = core.limit;
    quota.remaining = core.remaining;
    quota.reset = core.reset * 1000;
  } catch {
    /* 探不到就按默认节奏走 */
  }
}

/** 按剩余配额动态决定查多勤：越紧查得越疏，避免把自己耗死 */
function pollInterval() {
  if (quota.remaining === null) return POLL_MS;
  if (quota.remaining > 25) return POLL_MS; // 富余：15 秒
  if (quota.remaining > 12) return 30000; // 一般：30 秒
  return 60000; // 紧张：60 秒
}

/** 直接抓一个 JSON（会跟随 302 重定向，Release 附件域名必须跟随） */
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "oneno-pet-wait-release" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 从 minisign 的 base64 里取出 keyID（字节流第 3~10 字节，hex 大写）。
 * 输入既可以是「整份文件的 base64」（key.pub / latest.json 的 signature 都是这种），
 * 也可以直接是签名/公钥那一行本身 —— 解一层后如果不是文本就说明已经是裸行了。
 */
function minisignKeyId(b64) {
  if (!b64) return null;
  const first = Buffer.from(b64.trim(), "base64");
  const asText = first.toString("utf8");
  // 解一层后是可读文本 → 说明拿到的是整份文件，再取其中非注释的那一行
  const blob = asText.includes("untrusted comment")
    ? (() => {
        const line = asText.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("untrusted comment"));
        return line ? Buffer.from(line.trim(), "base64") : null;
      })()
    : first;
  return blob && blob.length >= 10 ? blob.subarray(2, 10).toString("hex").toUpperCase() : null;
}
const clock = (d = new Date()) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
const elapsed = (from, to = Date.now()) => {
  const s = Math.round((to - from) / 1000);
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
};

/** 找 tag 对应的 workflow run；没指定 tag 就取最新一次 push 触发且分支名像 tag 的 */
async function findRun(repo, tag) {
  const data = await api(`/repos/${repo.owner}/${repo.repo}/actions/runs?event=push&per_page=30`);
  const runs = data?.workflow_runs ?? [];
  if (tag) return runs.find((r) => r.head_branch === tag) ?? null;
  return runs.find((r) => /^v\d/.test(r.head_branch ?? "")) ?? null;
}

// ── 参数 ────────────────────────────────────────
if (argv.includes("--help") || argv.includes("-h")) {
  usage();
  process.exit(0);
}
const once = argv.includes("--once");
const ti = argv.indexOf("--timeout");
// 注意：--timeout 缺席时不能去读 argv[ti + 1]，否则 argv[0]（也就是 tag）会被当成超时值吃掉
const timeoutArg = ti >= 0 ? argv[ti + 1] : undefined;
const timeoutSec = Number(timeoutArg);
if (ti >= 0 && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
  fail("--timeout 后面要跟一个正整数秒数，例如 --timeout 1200");
}
const timeoutMs = (ti >= 0 ? timeoutSec : 900) * 1000;
// 同理，--token 的值也不能被当成 tag
const tag = argv.find((a) => !a.startsWith("-") && a !== timeoutArg && a !== tokenArg);

// ── 定位仓库与 run ──────────────────────────────
const repo = detectRepo();
if (!repo) fail("没从 .git/config 里解析出 GitHub 仓库地址");
if (!tag && !once) {
  console.log("\n没指定 tag，盯「最新一次 tag 构建」。");
}
actionsUrl = `https://github.com/${repo.owner}/${repo.repo}/actions`;

console.log(`\n仓库：${repo.owner}/${repo.repo}${tag ? `   tag：${tag}` : ""}`);

if (token) {
  console.log("已用令牌调用 API（配额 5000/小时）");
} else {
  await preflightQuota();
  if (quota.remaining !== null) {
    console.log(`匿名配额：剩 ${quota.remaining}/${quota.limit} 次`);
    if (quota.remaining === 0) {
      const waitMs = quota.reset - Date.now();
      if (waitMs > 0 && waitMs < timeoutMs) {
        const at = new Date(quota.reset).toLocaleTimeString("zh-CN");
        console.log(`配额已耗尽，等到 ${at} 重置后自动继续（不想等就 Ctrl+C，或加 --token）…`);
        await sleep(waitMs + 2000);
      } else {
        fail(`匿名配额已耗尽，重置还要约 ${Math.max(1, Math.ceil(waitMs / 60000))} 分钟。\n${quotaHint()}`);
      }
    }
  }
}

let run = null;
const findStart = Date.now();
while (!run) {
  run = await findRun(repo, tag);
  if (run) break;
  if (once) fail(`没找到${tag ? ` tag ${tag} 的` : ""}构建记录（可能还没触发）`, 1);
  if (Date.now() - findStart > FIND_RUN_TIMEOUT_MS) {
    fail(
      `等了 90 秒还没看到${tag ? ` tag ${tag} 的` : ""}构建记录。\n` +
        "  检查一下：① tag 推上去了吗（git push <remote> <tag>）\n" +
        "            ② .github/workflows/release.yml 的触发条件是否包含 tags",
    );
  }
  await sleep(5000);
}

console.log(`\n构建 #${run.run_number}  ${run.head_branch}  ${run.created_at}`);
console.log(`${run.html_url}\n`);

const startAt = new Date(run.created_at).getTime();
/** 构建实际耗时：用 run 的 updated_at 收尾，而不是「现在」——否则你事后回看会显示成「等了 14 分钟」 */
const costText = () => {
  const end = current?.updated_at ? new Date(current.updated_at).getTime() : Date.now();
  return elapsed(startAt, end);
};

/** 只打印变化了的那一行，避免刷屏 */
let lastKey = "";
function report(r) {
  const key = `${r.status}|${r.conclusion ?? ""}|${r._step ?? ""}`;
  if (key === lastKey) return;
  lastKey = key;
  const label =
    r.status === "completed"
      ? r.conclusion === "success"
        ? "✓ 成功"
        : `✖ ${r.conclusion}`
      : r._step
        ? `… 进行中 · ${r._step}`
        : `… ${r.status}`;
  console.log(`[${clock()}] +${elapsed(startAt)}  ${label}`);
}

let stepTick = STEPS_EVERY; // 首轮就拉一次步骤
let throttleNoticed = false;
let current = run;

while (true) {
  if (current.status === "completed") break;

  if (Date.now() - startAt > timeoutMs) {
    console.log(`\n⚠ 超过等待上限（${timeoutMs / 1000} 秒），构建仍在进行。`);
    console.log(`  去网页看：${run.html_url}\n`);
    process.exit(2);
  }

  const interval = pollInterval();
  await sleep(interval);
  const fresh = await api(`/repos/${repo.owner}/${repo.repo}/actions/runs/${run.id}`);
  if (!fresh) fail("构建记录消失了？");
  current = fresh;

  // 步骤详情查得疏一些；配额紧张时干脆不查（详情是「锦上添花」，别为它把配额耗光）
  if (current.status !== "completed") {
    const canFetchSteps = quota.remaining === null || quota.remaining > 12;
    if (stepTick >= STEPS_EVERY && canFetchSteps) {
      stepTick = 0;
      const jobs = await api(`/repos/${repo.owner}/${repo.repo}/actions/runs/${run.id}/jobs`);
      const steps = jobs?.jobs?.[0]?.steps ?? [];
      const active = steps.find((s) => s.status === "in_progress");
      const lastDone = [...steps].reverse().find((s) => s.status === "completed");
      current._step = active ? active.name : lastDone ? `已完成「${lastDone.name}」` : "";
    }
    stepTick++;
    // 降频时提示一次，免得用户以为卡住了
    if (interval > POLL_MS && !throttleNoticed) {
      throttleNoticed = true;
      console.log(`[${clock()}] 配额紧张（剩 ${quota.remaining} 次），查询间隔放宽到 ${interval / 1000} 秒`);
    }
  }
  report(current);
  if (once) break;
}

// ── 结果 ────────────────────────────────────────
const ok = current.conclusion === "success";
console.log(`\n────────────────────────────────────────────────`);
if (!ok) {
  const jobs = await api(`/repos/${repo.owner}/${repo.repo}/actions/runs/${run.id}/jobs`);
  const failed = (jobs?.jobs?.[0]?.steps ?? []).filter((s) => s.conclusion === "failure");
  console.error(`✖ 构建失败：${current.conclusion}（耗时 ${costText()}）`);
  if (failed.length) {
    console.error("  失败的步骤：");
    for (const s of failed) console.error(`    - ${s.name}`);
  }
  console.error(`  看日志：${run.html_url}\n`);
  process.exit(1);
}

console.log(`✓ 构建成功（耗时 ${costText()}）`);
console.log(`  产物应已上传：latest.json / *-setup.exe / *-setup.exe.sig`);

// 顺带看看发布状态 —— 草稿在匿名 API 里看不到，所以只能判断「是否已发布」
const rel = await api(`/repos/${repo.owner}/${repo.repo}/releases/latest`);
const want = tag ?? run.head_branch;
const published = rel?.tag_name === want;

if (published) {
  console.log(`\n✓ ${want} 已发布，且已是 latest（${rel.published_at}）`);
  console.log("  客户端现在点「检查更新」就能查到了。");
} else {
  console.log(`\n⚠ ${want} 还是草稿，尚未发布。`);
  console.log(`  releases/latest 当前仍指向 ${rel?.tag_name ?? "（无）"}`);
  console.log("  下一步：点草稿卡片右上角的铅笔图标 → 编辑页底部 → Publish release");
  console.log(`  直达链接：https://github.com/${repo.owner}/${repo.repo}/releases/edit/${want}`);
}

// ── 验签自检 ────────────────────────────────────
// 客户端内置的公钥来自 tauri.conf.json，CI 用的是仓库 Secret 里的私钥。
// 两者不是一对的话，更新会一路下载成功、最后卡在验签 —— 现象很有迷惑性，所以自动查一遍。
// 手法：比 minisign keyID（字节流第 3~10 字节，hex 大写），不需要任何密码学库。
// ⚠️ 坑：`<app>.key.pub` 与 latest.json 的 signature **都是整份文件的 base64**，
//    要先解一层拿到文件文本，取非 `untrusted comment` 的那行，再解一层才是字节流。
if (published) {
  try {
    const manifest = await fetchJson(
      `https://github.com/${repo.owner}/${repo.repo}/releases/latest/download/latest.json`,
    );
    const pubB64 = JSON.parse(readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"))
      ?.plugins?.updater?.pubkey;
    const platforms = Object.values(manifest?.platforms ?? {});
    const clientId = pubB64 ? minisignKeyId(pubB64) : null;
    const sigId = minisignKeyId(platforms[0]?.signature ?? "");
    if (clientId && sigId) {
      if (clientId === sigId) {
        console.log(`\n✓ 验签自检通过：客户端公钥与签名 keyID 一致（${clientId}）`);
      } else {
        console.error(`\n✖ 验签自检失败：客户端公钥 keyID ${clientId}，签名 keyID ${sigId}`);
        console.error("  两者不是一对 —— 客户端能下载但装不上。检查仓库 Secret 里的私钥。");
        process.exit(1);
      }
    }
  } catch (e) {
    console.log(`\n· 验签自检跳过（${e.message}）`);
  }
}
console.log("");
