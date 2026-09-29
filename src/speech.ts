import { getCurrentWindow, cursorPosition } from "@tauri-apps/api/window";
import { onSpeakRender, onSpeakHide, emitSpeakClosed } from "./core/bus";
import type { SpeakRenderPayload } from "./types";

// 独立气泡窗口：默认隐藏；每次说话由主窗口(main.ts)对本窗口 setPosition 后立刻 show（与右键菜单同一套
// 已验证可用的时序）——位置在 show 那一刻才提交，故不能常驻可见后再 setPosition（那样位置不生效，气泡会停在左上角）。
// 本窗口负责：点击穿透、渲染气泡内容与尖角、收起时隐藏自身。
// 提醒类会话框可要求「手动关闭」：此时额外开启光标命中检测，仅在光标落在气泡上时临时关闭整窗穿透。

// 提醒类图标（时钟）；短句碎碎念默认不显示图标
const CLOCK_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.2v5l3.2 2"/></svg>';

const win = getCurrentWindow();
const stageEl = document.getElementById("stage") as HTMLElement;
const bubbleEl = document.getElementById("bubble") as HTMLElement;
const txtEl = document.getElementById("bubble-txt") as HTMLElement;
const icoEl = document.getElementById("bubble-ico") as HTMLElement;
const okEl = document.getElementById("bubble-ok") as HTMLButtonElement;
const tailEl = bubbleEl.querySelector(".tail") as HTMLElement;

// 气泡与窗口左右缘的最小留白 / 尖角中心与气泡两端的最小距离（避开圆角）
const EDGE_PAD = 6;
const TAIL_MARGIN = 16;

/** 手动关闭模式下，判定光标是否落在气泡上的轮询间隔（毫秒） */
const HIT_POLL_MS = 100;
/** 命中区相对气泡外扩的像素（宁可多吞一点点击，也别让点击漏到下层程序） */
const HIT_PAD = 4;

let hideTimer: number | null = null;

// ── 手动关闭：光标命中检测 ──
// 气泡窗口整块 300×170 属于同一个 HWND，OS 级点击穿透只有「整窗」一档：
// 手动关闭时若整窗取消穿透，气泡之外的区域会变成挡住桌面/其它程序点击的死区。
// 故先缓存气泡几何，再轮询光标位置，仅在光标落在气泡矩形内时才取消穿透。
/** 缓存的气泡几何：窗口左上角物理坐标 + 缩放比 + 气泡矩形（相对窗口视口，逻辑像素） */
let hitGeom: {
  ox: number;
  oy: number;
  scale: number;
  box: { l: number; t: number; r: number; b: number };
} | null = null;
let hitTimer: number | null = null;
/** 命中检测是否处于激活态（异步取几何期间可能被 hide 打断） */
let hitActive = false;
/** 轮询是否在途，避免间隔到点时叠加请求 */
let polling = false;
/** 期望的穿透状态：true = 点击穿透（默认），false = 接收鼠标事件 */
let wantIgnore = true;
/** 已提交的穿透状态（null = 未知，下次必定同步一次） */
let appliedIgnore: boolean | null = null;
/** 是否有 setIgnoreCursorEvents 调用在途，避免并发堆积 */
let togglingIgnore = false;

// 按文本长度估算展示时长，夹在 3~8 秒
function estimateDuration(text: string): number {
  return Math.min(8000, Math.max(3000, 2400 + text.length * 130));
}

/** 提交点击穿透状态：目标态可能被连续改写（如 hide 紧随 pollHit），故内部循环追平最后一次请求，
 *  既不并发调用、也不会把中途的请求静默丢弃。 */
async function applyIgnore(next: boolean): Promise<void> {
  wantIgnore = next;
  if (togglingIgnore || appliedIgnore === wantIgnore) return;
  togglingIgnore = true;
  try {
    while (appliedIgnore !== wantIgnore) {
      const target = wantIgnore;
      await win.setIgnoreCursorEvents(target);
      appliedIgnore = target;
    }
  } catch (e) {
    console.error("speech setIgnoreCursorEvents 失败:", e);
  } finally {
    togglingIgnore = false;
  }
}

/** 判断光标是否落在气泡矩形内，据此切换穿透（读不到光标位置时维持现状，下个 tick 再试） */
async function pollHit(): Promise<void> {
  const g = hitGeom;
  if (!g || polling) return;
  polling = true;
  try {
    const p = await cursorPosition(); // 屏幕物理像素
    // 换算成相对窗口视口的逻辑坐标（与 offsetLeft/Top 同一坐标系）
    const lx = (p.x - g.ox) / g.scale;
    const ly = (p.y - g.oy) / g.scale;
    const inside = lx >= g.box.l && lx <= g.box.r && ly >= g.box.t && ly <= g.box.b;
    await applyIgnore(!inside);
  } catch {
    /* 读不到光标位置：保持当前状态 */
  } finally {
    polling = false;
  }
}

/** 开启命中检测：先同步量取气泡矩形（保证是本次渲染后的布局），再异步补上窗口坐标与缩放比 */
async function startHitTest(): Promise<void> {
  stopHitTest();
  hitActive = true;
  // 用 offset* 而非 getBoundingClientRect：气泡带 pop 入场动画（scale + translate），
  // getBoundingClientRect 返回的是变换后的矩形，会让命中区偏小偏位；
  // 而 .stage 是 inset:0 的 fixed 容器，气泡的 offsetLeft/Top 即窗口内视口坐标。
  const box = {
    l: bubbleEl.offsetLeft - HIT_PAD,
    t: bubbleEl.offsetTop - HIT_PAD,
    r: bubbleEl.offsetLeft + bubbleEl.offsetWidth + HIT_PAD,
    b: bubbleEl.offsetTop + bubbleEl.offsetHeight + HIT_PAD,
  };
  try {
    const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    if (!hitActive) return;
    hitGeom = { ox: pos.x, oy: pos.y, scale: scale || 1, box };
  } catch (e) {
    console.error("speech 命中几何获取失败:", e);
    if (!hitActive) return;
    hitGeom = null;
  }
  if (!hitActive) return;
  hitTimer = window.setInterval(() => void pollHit(), HIT_POLL_MS);
  void pollHit(); // 立即判一次，光标已在气泡上时无需等首个间隔
}

/** 停止命中检测并复位期望态（穿透的提交由调用方通过 applyIgnore(true) 完成） */
function stopHitTest(): void {
  hitActive = false;
  if (hitTimer !== null) {
    window.clearInterval(hitTimer);
    hitTimer = null;
  }
  hitGeom = null;
  wantIgnore = true;
}

// 收起气泡：清空视觉(is-hidden 防止下次 show 闪旧内容)、恢复整窗穿透并隐藏整个窗口
// （下次由主窗口 setPosition + show 一起提交新位置，气泡才会贴到桌宠头顶）
function hide(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  stopHitTest();
  bubbleEl.classList.remove("show-ok");
  okEl.textContent = "";
  void applyIgnore(true); // 恢复点击穿透，避免残留「死区」
  stageEl.classList.add("is-hidden");
  void win.hide();
  void emitSpeakClosed(); // 通知主窗口解除「手动会话框等待确认」状态
}

// 依据桌宠中心在窗口内的横向位置 tailX(逻辑px)，把气泡横向摆好并让尖角对准桌宠：
// 气泡尽量以尖角为中心，再夹进窗口避免裁切；尖角则在气泡内横移（避开圆角），
// 桌宠贴屏幕边缘时气泡不越界、尖角落到气泡靠桌宠的一端，从而始终指向桌宠。
function positionBubble(tailX?: number): void {
  const stageW = stageEl.clientWidth; // 逻辑窗口宽（≈ SPEECH_W）
  const bubbleW = bubbleEl.offsetWidth;
  const tx = tailX == null ? stageW / 2 : tailX;

  let left = Math.round(tx - bubbleW / 2);
  const maxLeft = Math.max(EDGE_PAD, stageW - EDGE_PAD - bubbleW);
  left = Math.min(Math.max(left, EDGE_PAD), maxLeft);
  bubbleEl.style.left = left + "px";

  let tail = tx - left; // 尖角相对气泡左缘
  tail = Math.min(Math.max(tail, TAIL_MARGIN), Math.max(TAIL_MARGIN, bubbleW - TAIL_MARGIN));
  tailEl.style.left = tail + "px";

  // 弹出动画从尖角处生长，视觉上像从桌宠"冒出"
  const originY = stageEl.classList.contains("is-flipped") ? "top" : "bottom";
  bubbleEl.style.transformOrigin = tail + "px " + originY;
}

// 主窗口已把本窗口摆到位并 show，这里渲染内容、按桌宠位置摆气泡与尖角，并重放弹出动画
function render(payload: SpeakRenderPayload): void {
  const text = (payload.text ?? "").trim();
  if (!text) return;

  stageEl.classList.toggle("is-flipped", payload.flipped === true);

  const showIco = payload.icon === true;
  txtEl.textContent = text;
  bubbleEl.classList.toggle("show-ico", showIco);
  icoEl.innerHTML = showIco ? CLOCK_SVG : "";

  // 手动关闭：显示右下角确认按钮，且不设自动收起；自动关闭：隐藏按钮，按文案长度自动收起
  const manual = payload.closeMode === "manual";
  bubbleEl.classList.toggle("show-ok", manual);
  okEl.textContent = manual ? (payload.confirmText ?? "知道了") : "";

  // 先显示（offsetWidth 才有值），再按桌宠位置摆气泡与尖角
  stageEl.classList.remove("is-hidden");
  positionBubble(payload.tailX);

  // 重放弹出动画（同一 JS 帧内完成，不会先闪到旧位置）
  bubbleEl.style.animation = "none";
  void bubbleEl.offsetWidth;
  bubbleEl.style.animation = "";

  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  if (manual) {
    // 手动关闭：整窗保持穿透，仅在光标落到气泡上时临时可交互
    void startHitTest();
  } else {
    // 自动关闭：维持点击穿透（与原有碎碎念行为一致）
    stopHitTest();
    void applyIgnore(true);
    hideTimer = window.setTimeout(hide, payload.durationMs ?? estimateDuration(text));
  }
}

async function boot(): Promise<void> {
  // 点击穿透（设一次，窗口样式随后续 show/hide 保留）；窗口默认隐藏，说话时由主窗口 show
  try {
    await win.setIgnoreCursorEvents(true);
    appliedIgnore = true;
  } catch (e) {
    console.error("speech setIgnoreCursorEvents 失败:", e);
  }
  // 不参与焦点竞争：点确认按钮时不抢走用户当前程序的焦点（WS_EX_NOACTIVATE，仍可收到鼠标消息）
  try {
    await win.setFocusable(false);
  } catch (e) {
    console.error("speech setFocusable 失败:", e);
  }
  // 手动关闭模式：只有右下角确认按钮能收起（点气泡其他位置不响应，避免误关）
  okEl.addEventListener("click", () => hide());
  await onSpeakRender((payload) => render(payload));
  await onSpeakHide(() => hide());
}

boot().catch((e) => console.error("speech 初始化失败:", e));
