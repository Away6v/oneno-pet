import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { loadConfig } from "./core/config";
import {
  onConfigChanged,
  onAssetsChanged,
  onCountdownState,
  onMenuPrepare,
  emitCountdownToggle,
  emitCountdownQuery,
} from "./core/bus";
import {
  getAvatarSrc,
  refreshCustomAssets,
  setHiddenBuiltins,
} from "./core/assetManager";
import type { AppConfig, FanSide } from "./types";

/**
 * 放射菜单项（数据驱动，支持任意层级）。
 * 带 children 即为可展开的父项：点击一级父项展开其二级项。
 */
interface RadialItem {
  id: string;
  label: string;
  icon: string; // 内联 SVG 字符串
  danger?: boolean;
  action?: () => void | Promise<void>;
  children?: RadialItem[];
}

// —— 线性图标（stroke 用 currentColor，随节点 hover / 危险态变色）——
const ICONS = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  power:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.1 1.9"/></svg>',
} as const;

// —— 菜单定义（下班倒计时 / 设置 / 退出）——
// 给任一项加 children 即成为可展开父项，点击会展开二级环（见 expand / collapseLevel2）。
// ⚠️ 每个菜单项 id 必须唯一（含二级）——expand() 靠 id 匹配高亮父项/淡出其余项。
const MENU: RadialItem[] = [
  {
    id: "quit",
    label: "退出",
    icon: ICONS.power,
    danger: true,
    action: quitApp,
  },
  {
    id: "countdown",
    label: "下班倒计时",
    icon: ICONS.clock,
    action: toggleCountdown,
  },
  {
    id: "settings",
    label: "设置",
    icon: ICONS.gear,
    action: openSettings,
  },
];
// —— 几何参数（窗口 480×480，中心即头像圆心；菜单是绕头像的扇环带）——
// 头像=圆心圆；一级项=相邻环形扇面拼成的扇形（留间隙）；二级项=更大半径的扇面，落在对应一级之外。
const CX = 240; // 窗口中心 X（头像圆心）
const CY = 240; // 窗口中心 Y
const L1_IN = 30; // 一级扇环内半径（头像半径 32，留约 3px 空隙）
const L1_OUT = 60; // 一级扇环外半径
const L2_IN = 70; // 二级扇环内半径（落在一级之外，留约 6px 空隙）
const L2_OUT = 100; // 二级扇环外半径
const L1_SPAN = 36; // 一级每项角宽（度）
const L1_GAP = 7; // 一级相邻项角间隙（度）：留一点缝，多项拼成扇形
const L2_SPAN = 24; // 二级每项角宽（度）
const L2_GAP = 6; // 二级相邻项角间隙（度）
const L1_ICON = 18; // 一级图标像素
const L2_ICON = 16; // 二级图标像素
const LABEL_OUT = 12; // 标签锚点浮在外弧之外的距离（px）
const LABEL_SLIDE = 5; // 标签浮现时沿径向朝圆心回缩的距离（px，做出「滑出来」的手感）
const LABEL_HIT_PAD = 5; // 标签命中矩形四周的外扩量（px）：贴着字形边缘也不丢悬浮
const L1_LEFT_DEG = 180; // 扇形朝左（默认）时的一级基准角
const L1_RIGHT_DEG = 0; // 扇形朝右（贴近屏幕左缘时翻转）
const STAGGER = 0.04; // 每项入场延迟（秒）
const BLOOM_PULL = 0.34; // 绽放起点：扇面沿「原点 → 质心」方向回缩的比例（越大越像从中心弹射出来）
const FAN_REACH = 130; // 扇形向一侧伸展的大致宽度（二级外半径 100 + 悬浮标签）；
//                       与主窗口判断翻转用的阈值保持一致，两处口径不能各写一个数

const win = getCurrentWindow();
let hasFocused = false; // 已获得过焦点：避免 show 后瞬时失焦误关
let opened = false; // 当前是否展示中：每次 show 重放绽放动画
let prepared = false; // 本次弹出是否已由主窗口预先定好朝向（正常路径恒为 true）
let current: AppConfig; // 最近一次配置（用于按当前角色 + 头像重绘）
let l1Side: FanSide = "left"; // 当前扇形朝向：默认朝左，靠屏幕左缘时翻向右
let expandedId: string | null = null; // 当前展开的一级父项 id
let countdownOn = false; // 下班倒计时面板当前是否打开（由主窗口广播，用于菜单项高亮）

/** 朝向 → 一级基准角（度） */
const sideDeg = (s: FanSide): number =>
  s === "right" ? L1_RIGHT_DEG : L1_LEFT_DEG;

// —— id → 菜单项索引（点击委托靠 id 反查项；含二级叶子）——
const itemById = new Map<string, RadialItem>();
(function indexItems(items: RadialItem[]): void {
  for (const it of items) {
    itemById.set(it.id, it);
    if (it.children) indexItems(it.children);
  }
})(MENU);

// —— DOM 引用 ——
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const radialEl = (): HTMLElement => el("radial");
const layerEl = (): SVGGElement =>
  document.getElementById("radial-layer") as unknown as SVGGElement;

// —— 极坐标 → 画布绝对坐标（原点=窗口中心，y 向下；deg 增大为顺时针）——
function polarPt(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

// —— 环形扇面路径（外弧顺时针 + 径向边 + 内弧逆时针闭合，要求 deg1<deg2）——
function sectorPath(
  rIn: number,
  rOut: number,
  deg1: number,
  deg2: number,
): string {
  const [ax, ay] = polarPt(rOut, deg1);
  const [bx, by] = polarPt(rOut, deg2);
  const [cx2, cy2] = polarPt(rIn, deg2);
  const [dx, dy] = polarPt(rIn, deg1);
  const large = Math.abs(deg2 - deg1) > 180 ? 1 : 0;
  return (
    `M${ax.toFixed(2)} ${ay.toFixed(2)}` +
    `A${rOut} ${rOut} 0 ${large} 1 ${bx.toFixed(2)} ${by.toFixed(2)}` +
    `L${cx2.toFixed(2)} ${cy2.toFixed(2)}` +
    `A${rIn} ${rIn} 0 ${large} 0 ${dx.toFixed(2)} ${dy.toFixed(2)}` +
    "Z"
  );
}

// —— HTML 转义（扇面标签/aria 文本安全）——
function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

// —— 把内联图标定位到扇面质心（正立；stroke=currentColor 随节点变色）——
// 外层套一个 <g> 作动画载体：transform-origin 用 viewBox 绝对坐标（图标中心），
// 于是图标能绕自身中心独立缩放 / 旋转 —— 直接对内层嵌套 <svg> 做 transform 会因它自建视口而取错参考框。
function iconMarkup(svg: string, cx: number, cy: number, size: number): string {
  return (
    `<g class="node-glyph" style="transform-origin:${cx.toFixed(1)}px ${cy.toFixed(1)}px">` +
    svg.replace(
      "<svg ",
      `<svg x="${(cx - size / 2).toFixed(2)}" y="${(
        cy -
        size / 2
      ).toFixed(2)}" width="${size}" height="${size}" `,
    ) +
    `</g>`
  );
}

// —— 生成一个扇面节点（一级 / 二级通用）的 SVG <g> 标记 ——
// deg1/deg2=扇面角度范围；level 决定内外半径与尺寸；ox/oy=绽放缩放原点
// （一级从窗口中心绽放，二级从父项质心绽放）。
function nodeMarkup(
  item: RadialItem,
  level: 1 | 2,
  deg1: number,
  deg2: number,
  delay: number,
  ox: number,
  oy: number,
): string {
  const rIn = level === 1 ? L1_IN : L2_IN;
  const rOut = level === 1 ? L1_OUT : L2_OUT;
  const iconSize = level === 1 ? L1_ICON : L2_ICON;
  const mid = (deg1 + deg2) / 2;
  const [icx, icy] = polarPt((rIn + rOut) / 2, mid); // 图标落在扇面质心
  const [lx, ly] = polarPt(rOut + LABEL_OUT, mid); // 标签锚点浮于外弧之外
  // 绽放起点：沿「绽放原点 → 扇面质心」方向回缩一段，让扇面从中心一侧弹射出来（比单纯缩放更有冲劲）
  const tx = (icx - ox) * -BLOOM_PULL;
  const ty = (icy - oy) * -BLOOM_PULL;
  // 标签朝「远离圆心」的一侧铺开：文字是水平排版的，若一律居中，正左 / 正右那几项的标签
  // 会沿径向压到扇面上（实测「下班倒计时」会压住 15px）。改用 text-anchor 让整段文字退到
  // 扇面之外 —— 比单纯把 LABEL_OUT 推大干净得多，也不会挤进二级扇环的地盘。
  const rad = (mid * Math.PI) / 180;
  const anchor = Math.cos(rad) < 0 ? "end" : "start";
  // 标签浮现时沿径向朝圆心回缩一点，做出「从扇面里滑出来」的手感
  const ltx = -Math.cos(rad) * LABEL_SLIDE;
  const lty = -Math.sin(rad) * LABEL_SLIDE;
  const hasChildren = !!(item.children && item.children.length);
  const cls =
    `node node--l${level}` +
    (item.danger ? " node--danger" : "") +
    (hasChildren ? " node--parent" : "");
  return (
    `<g class="${cls}" data-id="${esc(item.id)}" data-mid="${mid.toFixed(2)}" ` +
    `role="menuitem" aria-haspopup="${hasChildren ? "true" : "false"}" ` +
    `aria-label="${esc(item.label)}" ` +
    `style="--delay:${delay.toFixed(3)}s;--tx:${tx.toFixed(1)}px;--ty:${ty.toFixed(
      1,
    )}px;transform-origin:${ox.toFixed(1)}px ${oy.toFixed(1)}px;">` +
    // 扇面自己的 transform-origin 也要给：hover 外扩时绕同一原点，才与绽放方向一致
    `<path class="node-sector" d="${sectorPath(rIn, rOut, deg1, deg2)}" ` +
    `style="transform-origin:${ox.toFixed(1)}px ${oy.toFixed(1)}px"/>` +
    iconMarkup(item.icon, icx, icy, iconSize) +
    `<text class="node-label" x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" ` +
    `text-anchor="${anchor}" dominant-baseline="middle" ` +
    `style="--lx:${ltx.toFixed(1)}px;--ly:${lty.toFixed(1)}px;` +
    `transform-origin:${lx.toFixed(1)}px ${ly.toFixed(1)}px;">` +
    `${esc(item.label)}</text>` +
    // 标签的透明命中层：尺寸由 syncLabelHits() 在插入 DOM 后按文字实测盒填上
    `<rect class="node-hit"/>` +
    `</g>`
  );
}

// —— 给标签铺一层覆盖整段文字的透明命中矩形 ——
// SVG <text> 的命中区只有字形本身，鼠标沿文字横移会不停掉进字间空隙 → 标签忽隐忽现。
// 这层矩形的显隐跟着 .node:hover（而不是跟着标签），所以鼠标从扇面滑过来时它已经就位，
// 不会出现「要先命中标签才能显示标签」的死锁。
// 尺寸只能渲染后实测：文字盒取决于字体度量，靠字数估算会偏。
function syncLabelHits(scope: ParentNode): void {
  scope.querySelectorAll<SVGGElement>(".node").forEach((g) => {
    const text = g.querySelector<SVGTextElement>(".node-label");
    const hit = g.querySelector<SVGRectElement>(".node-hit");
    if (!text || !hit) return;
    const b = text.getBBox(); // 本地盒（不含 CSS transform），与同级的 rect 同坐标系
    hit.setAttribute("x", (b.x - LABEL_HIT_PAD).toFixed(2));
    hit.setAttribute("y", (b.y - LABEL_HIT_PAD).toFixed(2));
    hit.setAttribute("width", (b.width + LABEL_HIT_PAD * 2).toFixed(2));
    hit.setAttribute("height", (b.height + LABEL_HIT_PAD * 2).toFixed(2));
  });
}
// —— 构建一级扇形（相邻扇面 + 间隙，整体居中于当前朝向）——
function buildLevel1(): void {
  const layer = layerEl();
  layer.querySelectorAll(".node--l1").forEach((n) => n.remove());
  const n = MENU.length;
  const total = n * L1_SPAN + (n - 1) * L1_GAP; // 扇形总角跨度
  const start = sideDeg(l1Side) - total / 2; // 扇形整体居中于当前朝向
  let html = "";
  MENU.forEach((item, i) => {
    const d1 = start + i * (L1_SPAN + L1_GAP);
    html += nodeMarkup(item, 1, d1, d1 + L1_SPAN, i * STAGGER, CX, CY);
  });
  layer.insertAdjacentHTML("beforeend", html);
  applyCountdownActive(); // 节点刚被重建，重新套用「已开启」高亮
  syncLabelHits(layer); // 节点刚被重建，按实测文字盒重铺标签命中层
}

// —— 开关型菜单项高亮：给当前处于开启态的那一项（如下班倒计时）套上 node--on ——
function applyCountdownActive(): void {
  layerEl()
    .querySelectorAll<SVGGElement>('.node--l1[data-id="countdown"]')
    .forEach((g) => g.classList.toggle("node--on", countdownOn));
}
// —— 兜底：按菜单窗口当前屏幕位置推断扇形朝向 ——
// 正常路径由主窗口在 show 前预先告知（见 prepareMenu），此函数只在事件缺失时使用：
// 它依赖窗口位置，而位置要等 show 才提交，故只能在下次弹出时生效，绝不能放在动画路径上。
async function resolveFanSide(): Promise<FanSide> {
  try {
    const [pos, size, mon] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      currentMonitor(),
    ]);
    const centerX = pos.x + size.width / 2; // 头像（窗口中心）屏幕横坐标（物理像素）
    const left = mon ? mon.position.x : 0;
    const reach = size.width * (FAN_REACH / 480); // 按窗口实际宽度换算（FAN_REACH 是 480 逻辑宽下的值）
    return centerX - reach < left ? "right" : "left";
  } catch {
    return "left";
  }
}

// —— 把菜单归零到「完全收起」的初始态 ——
// 窗口 hide 后立即调用：下次 show 的第一帧必须是全透明，否则会先闪出上一轮残留的扇面。
// 归零期间挂 is-instant 关掉过渡 —— 窗口已不可见，不需要动画，也免得残留过渡在下次弹出时跳帧。
function resetAll(): void {
  const radial = radialEl();
  radial.classList.add("is-instant");
  radial.classList.remove("is-open");
  collapseLevel2(true);
  layerEl()
    .querySelectorAll<SVGGElement>(".node--l1")
    .forEach((n) => n.classList.remove("is-shown", "is-dim", "is-active"));
}

// —— 窗口显示前的准备（由主窗口在 show 之前通过事件驱动）——
// 朝向、扇面重建、状态归零全部在窗口可见之前完成，于是显示的第一帧就是最终布局，
// 之后只剩纯动画 → 不再出现「闪一下再重新显示」。
function prepareMenu(side: FanSide): void {
  resetAll();
  if (side !== l1Side) {
    l1Side = side;
    buildLevel1();
  }
  prepared = true;
}

// —— 绽放展示（show 后由 focus 事件触发）——
// 纯动画：不含任何异步查询与 DOM 重建，头像与扇面在同一帧起跑，节奏完全同步。
function bloomOpen(): void {
  const radial = radialEl();
  radial.classList.remove("is-instant"); // 恢复过渡（此刻所有节点都在初始态，不会跳变）
  void radial.offsetWidth; // 采样初始态，确保下面的加类被判为状态变化而重放过渡
  radial.classList.add("is-open"); // 中心头像绽放
  layerEl()
    .querySelectorAll<SVGGElement>(".node--l1")
    .forEach((n) => n.classList.add("is-shown")); // 扇面逐项绽放（各自带 stagger 延迟）
  void emitCountdownQuery(); // 询问主窗口面板当前状态，校正「已开启」高亮
}

// —— 点击某项：有子菜单则展开/收起二级，否则执行动作 ——
async function onItemClick(item: RadialItem, deg: number): Promise<void> {
  if (item.children && item.children.length) {
    if (expandedId === item.id) collapseLevel2();
    else expand(item, deg);
    return;
  }
  await item.action?.();
}

// —— 展开父项的二级扇环（落在对应一级扇面之外，以父项角度为中心的相邻扇形）——
function expand(item: RadialItem, parentMid: number): void {
  collapseLevel2(true);
  expandedId = item.id;
  const layer = layerEl();
  layer.querySelectorAll<SVGGElement>(".node--l1").forEach((g) => {
    const isParent = g.dataset.id === item.id;
    g.classList.toggle("is-dim", !isParent); // 其余一级项淡出
    g.classList.toggle("is-active", isParent); // 高亮当前父项
  });
  const kids = item.children ?? [];
  const m = kids.length;
  const total = m * L2_SPAN + (m - 1) * L2_GAP; // 二级扇形总跨度
  const start = parentMid - total / 2; // 以父项角度为中心（不平分整环）
  const [ox, oy] = polarPt((L1_IN + L1_OUT) / 2, parentMid); // 绽放原点=父项质心
  let html = "";
  kids.forEach((kid, j) => {
    const d1 = start + j * (L2_SPAN + L2_GAP);
    html += nodeMarkup(kid, 2, d1, d1 + L2_SPAN, j * STAGGER, ox, oy);
  });
  layer.insertAdjacentHTML("beforeend", html);
  syncLabelHits(layer); // 二级标签同样需要命中层
  const l2 = layer.querySelectorAll<SVGGElement>(".node--l2");
  layer.getBoundingClientRect(); // 强制回流，使 is-shown 过渡从初始态重放
  requestAnimationFrame(() => l2.forEach((n) => n.classList.add("is-shown")));
}
// —— 收起二级环 ——
function collapseLevel2(immediate = false): void {
  layerEl()
    .querySelectorAll<SVGGElement>(".node--l1")
    .forEach((n) => n.classList.remove("is-dim", "is-active"));
  const l2 = Array.from(layerEl().querySelectorAll<SVGGElement>(".node--l2"));
  expandedId = null;
  if (immediate) {
    l2.forEach((n) => n.remove());
    return;
  }
  l2.forEach((n) => n.classList.remove("is-shown")); // 先收回父项方向再移除
  window.setTimeout(() => l2.forEach((n) => n.remove()), 200);
}

// —— 关闭菜单 ——
function closeMenu(): void {
  hasFocused = false;
  opened = false;
  resetAll(); // 瞬时归零：hide 是异步的，不归零会在窗口消失前闪出一帧「头像缩回去」
  void win.hide();
}

// —— 动作 ——
async function openSettings(): Promise<void> {
  closeMenu();
  const settings = await WebviewWindow.getByLabel("settings");
  if (settings) {
    await settings.show();
    await settings.unminimize();
    await settings.setFocus();
  }
}
function quitApp(): void {
  void invoke("quit");
}
/** 切换下班倒计时面板（面板的显隐与定位由主窗口统一管理，本窗口只发请求） */
function toggleCountdown(): void {
  void emitCountdownToggle();
}

// —— 渲染中心头像 ——
async function render(): Promise<void> {
  const c = current.activeCharacter;
  const avatar = el<HTMLImageElement>("hub-avatar");
  avatar.src = await getAvatarSrc(c, current.avatarIds[c]);
  radialEl().dataset.character = c;
}
async function main(): Promise<void> {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("selectstart", (e) => e.preventDefault());
  document.addEventListener("dragstart", (e) => e.preventDefault());

  current = await loadConfig();
  setHiddenBuiltins(current.hiddenBuiltins);
  buildLevel1();
  // 弹出前准备：尽早注册，别让主窗口在 show 之前发来的朝向事件落空
  await onMenuPrepare((side) => prepareMenu(side));
  await render();

  // 点击中心头像：有二级则收起，否则关闭菜单
  el("hub").addEventListener("click", (e) => {
    e.stopPropagation();
    if (expandedId) collapseLevel2();
    else closeMenu();
  });
  // 点击委托：命中扇面项则执行/展开，点击空白背景则关闭
  radialEl().addEventListener("click", (e) => {
    const g = (e.target as Element).closest?.(".node") as SVGGElement | null;
    if (g) {
      const item = itemById.get(g.dataset.id || "");
      if (item)
        void onItemClick(item, parseFloat(g.dataset.mid || String(sideDeg(l1Side))));
      return; // 命中菜单项：不关闭菜单
    }
    closeMenu(); // 点击空白背景：关闭
  });
  // Esc：先收二级，否则关闭
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (expandedId) collapseLevel2();
    else closeMenu();
  });

  // 角色 / 头像变更后同步中心头像
  await onConfigChanged(async (next) => {
    current = next;
    setHiddenBuiltins(current.hiddenBuiltins); // 同步内置隐藏，避免头像解析到已隐藏造型
    await render();
  });
  // 自定义素材增删后刷新缓存并重绘
  await onAssetsChanged(async () => {
    await refreshCustomAssets();
    await render();
  });
  // 下班倒计时面板状态（主窗口广播）：更新菜单项高亮
  await onCountdownState((state) => {
    countdownOn = state.open;
    applyCountdownActive();
  });

  // 失焦即隐藏；获得焦点时（新一次弹出）重放绽放
  await win.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      hasFocused = true;
      if (!opened) {
        opened = true;
        // 正常情况下朝向已由 prepareMenu 定好；万一事件缺失（窗口尚未就绪），
        // 本次先按缓存朝向播放（绝不中途重建 → 不闪），异步校正留到下次弹出生效。
        if (!prepared) {
          void resolveFanSide().then((s) => {
            l1Side = s;
          });
        }
        prepared = false;
        bloomOpen();
      }
    } else if (hasFocused) {
      hasFocused = false;
      opened = false;
      resetAll(); // 与 closeMenu 一致：瞬时归零，避免消失前闪出收回动画
      void win.hide();
    }
  });
}

main().catch((e) => console.error("menu 初始化失败:", e));
