import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  availableMonitors,
  currentMonitor,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  LogicalPosition,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/dpi";
import { PetRenderer } from "./pet/PetRenderer";
import { AnimationScheduler } from "./pet/AnimationScheduler";
import { DragController } from "./pet/DragController";
import { loadConfig, saveConfig } from "./core/config";
import {
  emitSpeakHide,
  emitSpeakRender,
  emitCountdownState,
  emitMenuPrepare,
  onSpeak,
  onSpeakClosed,
  onConfigChanged,
  onAssetsChanged,
  onCountdownToggle,
  onCountdownQuery,
} from "./core/bus";
import { refreshCustomAssets, setHiddenBuiltins } from "./core/assetManager";
import { createReminderScheduler, type ReminderScheduler } from "./core/reminders";
import type { AppConfig, FanSide, SpeakPayload } from "./types";

const win = getCurrentWindow();

// 气泡（会话框）当前状态：idle 无 / auto 自动收起中 / manual 手动关闭等待用户确认。
// 手动等待期间拒绝一切新的说话，避免碎碎念或其它提醒把手动会话框覆盖掉。
let speechState: "idle" | "auto" | "manual" = "idle";
// 定时提醒调度器（在 main() 中创建后接入；配置变更时热更新）
let reminders: ReminderScheduler | null = null;
// 下班倒计时面板：当前是否显示 + 目标下班时间（复用 reminders.offwork.atTime，随配置热更新）。
// 面板是独立于气泡的另一个窗口，状态统一由本窗口（常驻的主窗口）持有。
let countdownOpen = false;
let countdownAtTime = "18:00";
// 面板跟随桌宠用的 rAF 句柄（0 = 无挂起）
let followRaf = 0;

// 菜单窗口尺寸（与 tauri.conf.json 保持一致）：放射菜单画布，中心头像正对光标
const MENU_W = 480;
const MENU_H = 480;
// 扇形朝左时弧带向左侧伸展的大致宽度（二级外半径 100 + 悬浮标签 ≈ 130）：
// 头像圆心到屏幕左缘的距离小于它，扇形就会被裁掉，此时翻向右（与 menu.ts 的几何参数对应）
const FAN_REACH = 130;
// 窗口比素材略大，给描边 / 反应动作留出余量
const WINDOW_PADDING = 12;
// 下班倒计时面板的「声明」尺寸（与 tauri.conf.json 的 countdown 窗口逻辑尺寸一致）。
// ⚠️ 只作兜底：Windows 会把过小的窗口撑到系统最小尺寸（实测 100 宽 → 约 136），
// 定位一律以窗口的实际 outerSize() 为准，否则卡片会偏半个差值（详见 computeCountdownPlacement）。
// 高度 = 卡片 42px（4+13+1+19+5）+ 底部 8px 投影余量；卡片贴窗口上缘，故窗口上缘 == 卡片上缘
const COUNTDOWN_W = 100;
const COUNTDOWN_H = 50;
// 卡片上缘与桌宠窗口下缘之间的逻辑间距（桌宠窗口下缘本身已在人物脚下 WINDOW_PADDING/2 处）
const COUNTDOWN_GAP = 4;
// 卡片宽度的「上界」（逻辑 px）：卡片在窗口内居中，两侧各有一段透明余量。
// 用它算出这段余量，就能让窗口在贴屏幕左右边缘时适当探出工作区，而卡片仍完整可见 ——
// 这样贴边时中轴不会被夹偏。取上界（宁大勿小）保证卡片一定不被裁掉。
// ⚠️ 需 ≥ countdown.css 里卡片的实际宽度（min-width 76 + 左右内边距，实测约 84）。
const COUNTDOWN_CARD_W = 90;

// ── 窗口层级 ──
// 桌宠的几个窗口都是 alwaysOnTop，彼此之间的上下关系由 Windows 置顶组的顺序决定。
// tauri 的 setAlwaysOnTop 在标志位没变化时是空操作，无法用来「再提一层」，
// 所以走后端 raise_window（内部直接 SetWindowPos(HWND_TOPMOST)，重复调用会重排到置顶组首位）。
// 用途：倒计时面板翻到人物上方时，气泡必须压在它上面（手动气泡带确认按钮，被盖住就点不到）。
function raiseWindow(label: string): void {
  void invoke("raise_window", { label }).catch((e) =>
    console.error(`raise_window(${label}) 失败:`, e),
  );
}

async function main(): Promise<void> {
  disableNativeGestures();

  const imgA = document.getElementById("pet-img-a") as HTMLImageElement;
  const imgB = document.getElementById("pet-img-b") as HTMLImageElement;
  const root = document.getElementById("pet-root") as HTMLElement;

  let config = await loadConfig();
  setHiddenBuiltins(config.hiddenBuiltins);
  countdownAtTime = config.reminders.offwork.atTime;

  const renderer = new PetRenderer(imgA, imgB);
  renderer.setSize(config.petSize);
  applyOpacity(root, config.petOpacity);
  await applyWindowSize(config.petSize);

  const scheduler = new AnimationScheduler(renderer, config.activeCharacter, {
    idleIntervalMs: config.idleIntervalMs,
    mode: config.behaviorMode,
    singleActionId: config.singleActionIds[config.activeCharacter],
  });
  await scheduler.start();

  // 左键：按住拖动窗口；拖动时切到「拖拽」造型并保持到松手（单击无动作）
  let dragging = false;

  // 拖拽真正结束后：收回工作区（避免被任务栏遮挡）并持久化位置
  const settlePosition = async (): Promise<void> => {
    const clamped = await clampToWorkArea();
    if (clamped) config.petPosition = clamped;
    void saveConfig(config);
  };

  new DragController(win, root, {
    onDragStart: () => {
      dragging = true;
      scheduler.showDrag();
      void emitSpeakHide(); // 拖动时先收起气泡，避免停留在旧位置
    },
    // 松手才结束拖拽造型（DragController 只在真实释放时回调，与计时无关）
    onDragEnd: () => {
      if (!dragging) return;
      dragging = false;
      scheduler.endDrag();
      void settlePosition();
    },
  });

  // 恢复上次位置（越界则回到屏幕中央）
  await restorePosition(config);

  // 右键：在光标处弹出自定义菜单
  root.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void showMenuAt(e.screenX, e.screenY);
  });

  // 位置持久化（防抖，避免拖动过程中频繁写盘）
  let saveTimer: number | null = null;
  await win.onMoved(({ payload }) => {
    config.petPosition = { x: payload.x, y: payload.y };
    scheduleCountdownFollow(); // 面板贴在桌宠下方：位置变化时同步跟随（rAF 节流）
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    // 拖拽中：仅记录坐标、绝不 clamp（避免定时触发挪动窗口打断拖拽）；结束时再统一收回工作区
    saveTimer = window.setTimeout(() => {
      if (dragging) void saveConfig(config);
      else void settlePosition();
    }, 400);
  });

  // 被系统标记为隐藏 / 遮挡时暂停动画并收起气泡，恢复时继续
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      scheduler.pause();
      void emitSpeakHide(); // 桌宠隐藏/遮挡时一并收起气泡，避免空窗口上残留旧气泡
      hideCountdownWithBroadcast(); // 倒计时面板贴在桌宠身上，一并收起
    } else {
      scheduler.resume();
    }
  });

  // 配置变更：切角色 / 改尺寸 / 改透明度 / 改间隔 / 改动作模式 / 改单一动作造型
  await onConfigChanged(async (next) => {
    const charChanged = next.activeCharacter !== config.activeCharacter;
    const sizeChanged = next.petSize !== config.petSize;
    const opacityChanged = next.petOpacity !== config.petOpacity;
    const hiddenChanged =
      JSON.stringify(next.hiddenBuiltins) !==
      JSON.stringify(config.hiddenBuiltins);
    config = { ...config, ...next };
    setHiddenBuiltins(config.hiddenBuiltins);
    scheduler.setConfig({
      idleIntervalMs: config.idleIntervalMs,
      mode: config.behaviorMode,
      singleActionId: config.singleActionIds[config.activeCharacter],
    });
    if (opacityChanged) applyOpacity(root, config.petOpacity);
    if (sizeChanged) {
      renderer.setSize(config.petSize);
      await applyWindowSize(config.petSize);
      // 变大后可能超出工作区，收回并记录新位置
      const clamped = await clampToWorkArea();
      if (clamped) {
        config.petPosition = clamped;
        void saveConfig(config);
      }
    }
    if (charChanged) await scheduler.setCharacter(config.activeCharacter);
    else if (hiddenChanged) await scheduler.reloadPools(); // 内置素材隐藏/复原：重载当前角色播放池
    reminders?.setConfig(config); // 提醒配置热更新（仅触发时刻相关字段变化才重算倒计时）
    // 下班时间可能被改：面板开着时广播新目标时间，让它重算倒计时
    const nextAt = config.reminders.offwork.atTime;
    if (nextAt !== countdownAtTime) {
      countdownAtTime = nextAt;
      if (countdownOpen) broadcastCountdownState();
    }
  });

  // 素材变更：刷新缓存并重载当前角色播放池
  await onAssetsChanged(async () => {
    await refreshCustomAssets();
    await scheduler.reloadPools();
  });

  // 气泡定位协调：主窗口按桌宠几何摆好独立气泡窗口，再通知其渲染显示
  setupSpeechCoordinator();

  // 下班倒计时面板协调：菜单窗口发 toggle / query，本窗口负责定位、显隐与状态广播
  setupCountdownCoordinator();

  // 定时提醒：久坐 / 喝水 / 下班。弹窗走 showSpeech，未弹成功（桌宠隐藏 / 手动会话框未关）则下个 tick 重试
  reminders = createReminderScheduler((payload) => showSpeech(payload));
  reminders.setConfig(config);

  // 闲置碎碎念：空闲时随机间隔弹一句（气泡由独立 speech 窗口渲染）
  startIdleChatter(() => dragging);
}

async function applyWindowSize(size: number): Promise<void> {
  const edge = Math.round(size + WINDOW_PADDING);
  await win.setSize(new LogicalSize(edge, edge));
}

// 应用桌宠不透明度：作用于容器（图片自身的 opacity 用于交叉淡入，勿覆盖）
function applyOpacity(root: HTMLElement, opacity: number): void {
  root.style.opacity = String(opacity);
}

async function restorePosition(config: AppConfig): Promise<void> {
  const pos = config.petPosition;
  if (!pos || !(await isOnScreen(pos.x, pos.y))) {
    await win.center();
  } else {
    await win.setPosition(new PhysicalPosition(pos.x, pos.y));
  }
  // 无论恢复上次位置还是回到中央，都确保窗口没有压在任务栏下方。
  // 此刻 onMoved 监听尚未注册，位置变化必须自行落盘，否则下次启动仍按旧坐标恢复。
  const clamped = await clampToWorkArea();
  if (!clamped) return;
  if (!pos || clamped.x !== pos.x || clamped.y !== pos.y) {
    config.petPosition = clamped;
    void saveConfig(config);
  }
}

// 判断保存的物理坐标是否仍落在某个显示器范围内（含 8px 容差）
async function isOnScreen(x: number, y: number): Promise<boolean> {
  try {
    const monitors = await availableMonitors();
    if (monitors.length === 0) return true;
    return monitors.some((m) => {
      const left = m.position.x - 8;
      const top = m.position.y - 8;
      const right = m.position.x + m.size.width + 8;
      const bottom = m.position.y + m.size.height + 8;
      return x >= left && x < right && y >= top && y < bottom;
    });
  } catch {
    return true;
  }
}

// 把主窗口收拢到当前显示器的“工作区”（屏幕去掉任务栏 / Dock 后的区域）内，
// 避免桌宠底部或边缘被任务栏遮挡。workArea、位置、尺寸均为物理像素。
// 返回收拢后的物理坐标；获取失败时返回 null。
async function clampToWorkArea(): Promise<{ x: number; y: number } | null> {
  try {
    const monitor = await currentMonitor();
    if (!monitor) return null;
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    const waX = monitor.workArea.position.x;
    const waY = monitor.workArea.position.y;
    const maxX = waX + monitor.workArea.size.width - size.width;
    const maxY = waY + monitor.workArea.size.height - size.height;
    // 工作区比窗口还小的极端情况下，至少保证左上角可见（maxX/maxY 可能 < waX/waY）
    const x = Math.round(Math.min(Math.max(pos.x, waX), Math.max(waX, maxX)));
    const y = Math.round(Math.min(Math.max(pos.y, waY), Math.max(waY, maxY)));
    if (x !== pos.x || y !== pos.y) {
      await win.setPosition(new PhysicalPosition(x, y));
    }
    return { x, y };
  } catch (e) {
    console.error("clampToWorkArea 失败:", e);
    return null;
  }
}

async function showMenuAt(screenX: number, screenY: number): Promise<void> {
  const menu = await WebviewWindow.getByLabel("menu");
  if (!menu) return;
  // 头像（窗口中心）对准光标：横向让“空的一侧”自然出屏，扇形朝向由菜单窗口按屏缘自行翻转；
  // 纵向夹住头像，保证扇形弧带不被屏幕上下缘裁掉。
  const V_MARGIN = 100; // 内容相对中心的纵向半高（扇形弧带）
  const availH = window.screen.availHeight;
  const avatarY = Math.min(
    Math.max(screenY, V_MARGIN),
    Math.max(V_MARGIN, availH - V_MARGIN),
  );
  const x = Math.round(screenX - MENU_W / 2);
  const y = Math.round(avatarY - MENU_H / 2);

  // 扇形朝向在 show 之前定好：窗口中心即头像圆心（正对光标），故按光标横坐标判断即可。
  // 朝左时弧带向左侧伸展约 FAN_REACH，据此判断是否已贴到所在显示器左缘（贴边则翻向右）。
  // 先告知菜单窗口，让它在窗口显示前就按最终朝向重建扇面并归零 —— 显示后不再重排。
  const scale = window.devicePixelRatio || 1;
  const mon = await monitorContaining(
    Math.round(screenX * scale),
    Math.round(avatarY * scale),
  );
  const monLeft = mon ? mon.position.x : 0;
  const side: FanSide =
    (screenX - FAN_REACH) * scale < monLeft ? "right" : "left";
  await emitMenuPrepare(side);

  await menu.setPosition(new LogicalPosition(x, y));
  await menu.show();
  await menu.setFocus();
}

// 屏蔽系统右键菜单 / 文本选择 / 图片拖拽等默认行为
function disableNativeGestures(): void {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("dragstart", (e) => e.preventDefault());
  document.addEventListener("selectstart", (e) => e.preventDefault());
}

// ── 气泡（会话框）定位协调 ──
// 由掌握桌宠几何的主窗口统一定位：把独立气泡窗口摆到桌宠头顶（放不下则翻到下方），
// 摆好后通知气泡窗口渲染显示。跨窗口查询主窗口几何在实测中不稳定，故收敛到此处用主窗口自身几何计算。
const SPEECH_W = 300; // 与 tauri.conf.json 的 speech 窗口逻辑尺寸一致
const SPEECH_H = 170;
const SPEECH_GAP = 3; // 尖角与桌宠之间的逻辑间距（贴紧头顶）

// 找到包含指定物理坐标点的显示器（回退到第一个）
async function monitorContaining(px: number, py: number) {
  try {
    const monitors = await availableMonitors();
    if (monitors.length === 0) return null;
    const hit = monitors.find(
      (m) =>
        px >= m.position.x &&
        px < m.position.x + m.size.width &&
        py >= m.position.y &&
        py < m.position.y + m.size.height,
    );
    return hit ?? monitors[0];
  } catch {
    return null;
  }
}

// 依据桌宠(主窗口)几何算出气泡窗口应处的物理坐标、是否翻转（头顶放不下则翻到下方），
// 以及桌宠中心相对气泡窗口左缘的横向位置 tailX（逻辑像素，供尖角横移始终指向桌宠）
async function computeSpeechPlacement(): Promise<{
  x: number;
  y: number;
  flipped: boolean;
  tailX: number;
} | null> {
  try {
    const pp = await win.outerPosition(); // 物理像素
    const ps = await win.outerSize(); // 物理像素
    let scale = 1;
    try {
      scale = await win.scaleFactor();
    } catch {
      /* 读不到缩放按 1 处理 */
    }
    const spW = Math.round(SPEECH_W * scale);
    const spH = Math.round(SPEECH_H * scale);
    const gap = Math.round(SPEECH_GAP * scale);

    const petCx = pp.x + ps.width / 2;
    const petTop = pp.y;
    const petBottom = pp.y + ps.height;

    const mon = await monitorContaining(Math.round(petCx), Math.round(petTop));
    const waTop = mon ? mon.workArea.position.y : petTop - spH - gap;
    const waLeft = mon ? mon.workArea.position.x : petCx - spW;
    const waRight = mon
      ? mon.workArea.position.x + mon.workArea.size.width
      : petCx + spW;

    const flipped = petTop - spH - gap < waTop; // 头顶放不下 → 翻到下方
    let x = Math.round(petCx - spW / 2);
    x = Math.min(Math.max(x, waLeft), Math.max(waLeft, waRight - spW)); // 横向夹进工作区
    const y = flipped
      ? Math.round(petBottom + gap)
      : Math.round(petTop - spH - gap);
    // 桌宠中心落在气泡窗口内的横向逻辑坐标（窗口贴边被夹后，尖角据此对准桌宠）
    const tailX = (petCx - x) / scale;
    return { x, y, flipped, tailX };
  } catch (e) {
    console.error("computeSpeechPlacement 失败:", e);
    return null;
  }
}

// 摆好气泡窗口并通知其渲染显示（供 onSpeak 监听、闲置碎碎念与定时提醒调用）。
// 返回是否真的弹了出来：调度器据此决定要不要推进下次提醒时刻（没弹就保持到期态重试）。
async function showSpeech(payload: SpeakPayload): Promise<boolean> {
  if (!payload || !payload.text) return false;
  // 手动会话框等待用户确认期间，拒绝一切新的说话，避免被碎碎念/其它提醒覆盖
  if (speechState === "manual") return false;
  if (document.hidden) return false; // 桌宠被遮挡/隐藏时不弹
  try {
    if (!(await win.isVisible())) return false;
  } catch {
    /* 读不到可见性则继续 */
  }
  const place = await computeSpeechPlacement();
  if (!place) return false;
  const speech = await WebviewWindow.getByLabel("speech");
  if (!speech) return false;
  try {
    // 关键时序：与右键菜单同一套（已验证可用）——先 setPosition 再立刻 show，
    // 位置在 show 那一刻才提交。隐藏态/常驻可见后再 setPosition 都不生效（气泡会停在左上角）。
    await speech.setPosition(new PhysicalPosition(place.x, place.y));
    await speech.show();
    // 气泡永远压在倒计时面板之上（面板翻到人物上方时会与气泡重叠）
    raiseWindow("speech");
  } catch (e) {
    console.error("speech setPosition/show 失败:", e);
    return false;
  }
  speechState = payload.closeMode === "manual" ? "manual" : "auto";
  await emitSpeakRender({
    ...payload,
    flipped: place.flipped,
    tailX: place.tailX,
  });
  return true;
}

// 监听任意窗口发起的 speak（程序事件通知 API）；本窗口自身的碎碎念直接调用 showSpeech，
// 不依赖 emit 是否会回投到发起窗口。
function setupSpeechCoordinator(): void {
  void onSpeak((payload) => void showSpeech(payload));
  // 气泡收起（自动到时 / 手动点确认 / 拖拽或隐藏时被强制收起）→ 解除等待态
  void onSpeakClosed(() => {
    speechState = "idle";
  });
}

// ── 下班倒计时面板协调 ──
// 与气泡（会话框）互相独立的另一个窗口：面板只负责渲染与计时，状态由本窗口持有；
// 菜单窗口发 toggle / query，本窗口负责定位、显隐与状态广播。
// 定位规则：优先贴在人物下方；下方放不下则翻到人物上方（与气泡同一套「优先 / 翻转」思路），
// 上下都放不下时选空间更大的一侧。横向中轴始终与人物中轴对齐。
// workArea、位置、尺寸均为物理像素。

/** 广播面板状态（菜单窗口据此高亮菜单项、面板窗口据此启停计时） */
function broadcastCountdownState(): void {
  void emitCountdownState({ open: countdownOpen, atTime: countdownAtTime });
}

async function computeCountdownPlacement(): Promise<{ x: number; y: number } | null> {
  try {
    const pp = await win.outerPosition();
    const ps = await win.outerSize();
    let scale = 1;
    try {
      scale = await win.scaleFactor();
    } catch {
      /* 读不到缩放按 1 处理 */
    }
    const cw = Math.round(COUNTDOWN_W * scale);
    const ch = Math.round(COUNTDOWN_H * scale);
    const gap = Math.round(COUNTDOWN_GAP * scale);

    // 面板窗口的「实际」外框尺寸：Windows 会把过小的窗口撑到系统最小尺寸
    // （实测声明 100 宽、实际约 136）。卡片是在窗口内居中的，若按声明宽度居中，
    // 卡片会整体右偏 (实际宽 - 声明宽) / 2 —— 这就是「中轴没对齐」的根因。
    // 故一律按实际尺寸居中；窗口还没建好等异常情况退回声明尺寸。
    let panelW = cw;
    let panelH = ch;
    const cd = await WebviewWindow.getByLabel("countdown");
    if (cd) {
      try {
        const cs = await cd.outerSize();
        if (cs.width > 0) panelW = cs.width;
        if (cs.height > 0) panelH = cs.height;
      } catch {
        /* 读不到就用声明尺寸 */
      }
    }

    const petCx = pp.x + ps.width / 2;
    const petTop = pp.y;
    const petBottom = pp.y + ps.height;

    const mon = await monitorContaining(Math.round(petCx), Math.round(petTop));
    const waX = mon ? mon.workArea.position.x : 0;
    const waY = mon ? mon.workArea.position.y : 0;
    const waW = mon ? mon.workArea.size.width : panelW;
    const waH = mon ? mon.workArea.size.height : panelH;
    const waRight = waX + waW;
    const waBottom = waY + waH;

    // 横向：面板中轴对齐桌宠中轴（桌宠窗口左右对称，窗口中心即人物中心）。
    // 夹取时以「卡片」为准而非窗口：卡片在窗口内居中，窗口左右各有一段透明余量，
    // 允许窗口贴边时探出这一段，卡片仍完整可见 —— 这样贴屏幕左右边缘时中轴也不会被夹偏。
    const cardW = Math.round(COUNTDOWN_CARD_W * scale);
    const slack = Math.max(0, Math.round((panelW - cardW) / 2));
    const x = Math.round(
      Math.min(
        Math.max(petCx - panelW / 2, waX - slack),
        Math.max(waX - slack, waRight - panelW + slack),
      ),
    );

    // 纵向：优先贴在人物下方；下方放不下则翻到人物上方（与气泡同一套「优先 / 翻转」思路）。
    // 翻转后靠 raiseWindow("speech") 保证气泡仍压在面板之上，不会出现层级冲突。
    const belowY = Math.round(petBottom + gap);
    const aboveY = Math.round(petTop - panelH - gap);
    let y: number;
    if (belowY + panelH <= waBottom) {
      y = belowY; // 下方放得下
    } else if (aboveY >= waY) {
      y = aboveY; // 翻到人物上方
    } else {
      // 上下都放不下（工作区极矮）：选剩余空间更大的一侧，再夹进工作区
      y = waBottom - petBottom >= petTop - waY ? waBottom - panelH : aboveY;
      y = Math.min(Math.max(y, waY), Math.max(waY, waBottom - panelH));
    }
    return { x, y };
  } catch (e) {
    console.error("computeCountdownPlacement 失败:", e);
    return null;
  }
}

// 摆好面板窗口并显示。时序与气泡同一套（已验证可用）：先 setPosition 再立刻 show，
// 位置在 show 那一刻才提交；隐藏态或常驻可见后再 setPosition 都不生效。
async function showCountdown(): Promise<boolean> {
  if (document.hidden) return false; // 桌宠被隐藏时不显示
  try {
    if (!(await win.isVisible())) return false;
  } catch {
    /* 读不到可见性则继续 */
  }
  const place = await computeCountdownPlacement();
  if (!place) return false;
  const cd = await WebviewWindow.getByLabel("countdown");
  if (!cd) return false;
  try {
    await cd.setPosition(new PhysicalPosition(place.x, place.y));
    await cd.show();
  } catch (e) {
    console.error("countdown setPosition/show 失败:", e);
    return false;
  }
  // 显示窗口会把它排到置顶组前面：面板翻到人物上方时会与气泡重叠，
  // 此处把已经在显示的气泡重新提回置顶组首位，保证气泡始终压着面板。
  try {
    const speech = await WebviewWindow.getByLabel("speech");
    if (speech && (await speech.isVisible())) raiseWindow("speech");
  } catch {
    /* 读不到可见性不影响面板显示 */
  }
  return true;
}

/** 仅同步面板位置（面板已可见时用；拖拽跟随走这里） */
async function moveCountdown(): Promise<void> {
  const place = await computeCountdownPlacement();
  if (!place) return;
  const cd = await WebviewWindow.getByLabel("countdown");
  if (!cd) return;
  try {
    await cd.setPosition(new PhysicalPosition(place.x, place.y));
  } catch {
    /* 窗口可能正被隐藏，忽略 */
  }
}

/** 收起面板（只隐藏不销毁，保持窗口单例可复用） */
async function hideCountdown(): Promise<void> {
  const cd = await WebviewWindow.getByLabel("countdown");
  if (!cd) return;
  try {
    await cd.hide();
  } catch (e) {
    console.error("countdown hide 失败:", e);
  }
}

/** 切换面板显隐（菜单窗口发起）。打开失败（桌宠不可见 / 定位失败）时保持关闭态，不广播 */
async function toggleCountdown(): Promise<void> {
  if (countdownOpen) {
    countdownOpen = false;
    await hideCountdown();
  } else {
    if (!(await showCountdown())) return;
    countdownOpen = true;
  }
  broadcastCountdownState();
}

/** 窗口移动时同步面板位置：rAF 节流，避免拖动过程中高频 setPosition 堆积 */
function scheduleCountdownFollow(): void {
  if (!countdownOpen || followRaf !== 0) return;
  followRaf = window.requestAnimationFrame(() => {
    followRaf = 0;
    if (countdownOpen) void moveCountdown();
  });
}

/** 收起面板并广播状态（桌宠被隐藏 / 遮挡时联动调用，顺带解除菜单项高亮） */
function hideCountdownWithBroadcast(): void {
  if (!countdownOpen) return;
  countdownOpen = false;
  void hideCountdown();
  broadcastCountdownState();
}

function setupCountdownCoordinator(): void {
  void onCountdownToggle(() => void toggleCountdown());
  // 菜单每次绽放时询问一次当前状态：避免任何时序导致的菜单高亮与实际不符
  void onCountdownQuery(() => broadcastCountdownState());
}

// 闲置碎碎念预设短句（暖棕友好风）
const CHATTER_PHRASES = [
  "今天也要元气满满哦～",
  "在忙什么呢？记得抬头看看远方～",
  "我一直在这儿陪着你呀。",
  "要不要伸个懒腰，动一动？",
  "累了就歇一会儿，我等你。",
  "专注的你，超棒的！",
  "记得喝口水，休息一下下～",
];
const CHATTER_MIN_MS = 45000;
const CHATTER_MAX_MS = 90000;

// 每隔 CHATTER_MIN~MAX 毫秒随机挑一句(不与上次重复)；isBusy() 为真(拖拽)或窗口隐藏时跳过
function startIdleChatter(isBusy: () => boolean): void {
  let last = -1;
  const pick = (): string => {
    let i = Math.floor(Math.random() * CHATTER_PHRASES.length);
    if (i === last) i = (i + 1) % CHATTER_PHRASES.length;
    last = i;
    return CHATTER_PHRASES[i];
  };
  const next = (): void => {
    const delay =
      CHATTER_MIN_MS + Math.random() * (CHATTER_MAX_MS - CHATTER_MIN_MS);
    window.setTimeout(() => {
      if (!isBusy() && !document.hidden) void showSpeech({ text: pick() });
      next();
    }, delay);
  };
  next();
}

main().catch((e) => console.error("main 初始化失败:", e));
