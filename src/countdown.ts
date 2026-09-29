import { getCurrentWindow } from "@tauri-apps/api/window";
import { onCountdownState } from "./core/bus";
import { nextDailyAt } from "./core/reminders";
import type { CountdownState } from "./types";

// 独立的下班倒计时面板窗口（与气泡会话框 speech 窗口互相独立，可同时显示）。
// 职责边界：只负责渲染与计时，不持有业务状态——「是否打开」由主窗口持有，
// 目标时间随 CountdownState 事件下发；面板自身不接收鼠标（常驻点击穿透），开合由右键菜单控制。

const win = getCurrentWindow();
const rootEl = document.getElementById("cd") as HTMLElement;
const cardEl = document.querySelector(".cd-card") as HTMLElement;
const labelEl = document.getElementById("cd-label") as HTMLElement;
const timeEl = document.getElementById("cd-time") as HTMLElement;

/** 刷新间隔：1 秒。每次以 Date.now() 重算剩余而非累减，避免长时间运行后漂移 */
const TICK_MS = 1000;

/** 当前目标下班时间 "HH:MM"（取自 reminders.offwork.atTime） */
let atTime = "18:00";
/** 本次计时的目标时间戳 */
let target = 0;
/** target 是按哪个 atTime 算出来的；与 atTime 不一致时需要重算（含首次打开） */
let computedFor: string | null = null;
/** 是否已进入「下班啦」态：到点后保持，跨到新的一天再自动重新计时 */
let done = false;
/** 面板是否处于打开状态（关闭时停表省电） */
let open = false;
let timer: number | null = null;

/** 两个时间戳是否落在同一个本地日期（用本地字段比较，避免 UTC 跨时区误判） */
function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 毫秒 → "HH:MM:SS"（每日循环，小时数不会超过 23，故补零到两位即可） */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** 渲染倒计时态 */
function renderRemaining(ms: number): void {
  cardEl.classList.remove("is-done");
  labelEl.textContent = "距离下班";
  timeEl.textContent = formatRemaining(ms);
}

/** 渲染到点态（保持显示，直到用户手动关闭） */
function renderDone(): void {
  cardEl.classList.add("is-done");
  labelEl.textContent = "今天辛苦啦";
  timeEl.textContent = "下班啦";
}

function tick(): void {
  const now = Date.now();
  if (done) {
    // 到点后不能每 tick 重算（否则会立刻又变回倒计时），靠「是否已跨到新的一天」门控
    if (sameLocalDay(now, target)) return;
    done = false;
    target = nextDailyAt(atTime, now);
  }
  const rem = target - now;
  if (rem <= 0) {
    done = true;
    renderDone();
    return;
  }
  renderRemaining(rem);
}

function startTimer(): void {
  stopTimer();
  tick(); // 立即渲染一次，避免首帧显示占位符
  timer = window.setInterval(tick, TICK_MS);
}

function stopTimer(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/** 应用一次状态：打开时按 atTime 起算并启动计时，关闭时停表并隐藏卡片 */
function apply(state: CountdownState): void {
  atTime = state.atTime;
  open = state.open;

  if (!open) {
    stopTimer();
    rootEl.classList.add("is-hidden");
    return;
  }
  rootEl.classList.remove("is-hidden");
  if (computedFor !== atTime) {
    // 首次打开，或目标时间被改过：从当前时刻重新起算，并复位到点态
    done = false;
    target = nextDailyAt(atTime, Date.now());
    computedFor = atTime;
  }
  startTimer();
}

async function boot(): Promise<void> {
  // 点击穿透 + 不抢焦点：面板纯展示，全程不需要鼠标交互（开合由右键菜单控制）
  try {
    await win.setIgnoreCursorEvents(true);
  } catch (e) {
    console.error("countdown setIgnoreCursorEvents 失败:", e);
  }
  try {
    await win.setFocusable(false);
  } catch (e) {
    console.error("countdown setFocusable 失败:", e);
  }

  await onCountdownState((state) => apply(state));

  // 被系统标记为隐藏 / 遮挡时停表，恢复时若面板仍开着则续上
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopTimer();
    else if (open) startTimer();
  });
}

boot().catch((e) => console.error("countdown 初始化失败:", e));
