import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { loadConfig, saveConfig, REMINDER_TEXT_MAX } from "./core/config";
import {
  emitConfigChanged,
  emitAssetsChanged,
  onAssetsChanged,
} from "./core/bus";
import {
  listAllForCharacter,
  addCustomAsset,
  removeCustomAsset,
  getAvatarSrc,
  setHiddenBuiltins,
} from "./core/assetManager";
import {
  ALLOWED_EXTENSIONS,
  DEFAULT_CONFIG,
  CHARACTER_NAMES,
  CHARACTER_DESC,
  AUTHORS,
  RELEASE_PAGE_URL,
  SLOGAN,
  REMINDER_INTERVAL_BOUNDS,
  REMINDER_KINDS,
  REMINDER_META,
  makeDefaultReminders,
} from "./types";
import type {
  AppConfig,
  AssetCategory,
  AssetItem,
  BehaviorMode,
  CharacterKey,
  IntervalUnit,
  ReminderCloseMode,
  ReminderKind,
} from "./types";

type FilterKey = "all" | AssetCategory;

/** 频率单位 → 毫秒倍率 */
const UNIT_MS: Record<IntervalUnit, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};
/** 动作模式 → 中文标签（总览页展示用） */
const BEHAVIOR_MODE_LABEL: Record<BehaviorMode, string> = {
  single: "单一动作",
  random: "随机轮播",
  sequential: "顺序轮播",
};
/** 每个单位下数值输入的整数上下限（均落在全局 1s~24h 范围内） */
const UNIT_BOUNDS: Record<IntervalUnit, { min: number; max: number }> = {
  s: { min: 1, max: 86_400 }, // 1 秒 ~ 24 小时
  m: { min: 1, max: 1_440 }, //  1 分 ~ 24 小时
  h: { min: 1, max: 24 }, //    1 小时 ~ 24 小时
};

/** 毫秒 → 指定单位的整数值（就近取整并夹取到该单位的上下限） */
function msToUnit(
  ms: number,
  unit: IntervalUnit,
  bounds = UNIT_BOUNDS,
): number {
  const b = bounds[unit];
  return clampNum(Math.round(ms / UNIT_MS[unit]), b.min, b.max);
}

/** 指定单位的数值 → 毫秒（先夹取到该单位上下限，保证吸附到整单位） */
function unitToMs(
  value: number,
  unit: IntervalUnit,
  bounds = UNIT_BOUNDS,
): number {
  const b = bounds[unit];
  const v = clampNum(Math.round(value) || b.min, b.min, b.max);
  return v * UNIT_MS[unit];
}

/** 按单位设置数值输入框的 min/max 属性（默认作用于「切换频率」输入框；提醒间隔行传入自己的输入框与边界） */
function applyIntervalUnitBounds(
  unit: IntervalUnit,
  input: HTMLInputElement = byId<HTMLInputElement>("opt-interval"),
  bounds: Record<IntervalUnit, { min: number; max: number }> = UNIT_BOUNDS,
): void {
  input.min = String(bounds[unit].min);
  input.max = String(bounds[unit].max);
}

/** 回填「单位」分段控件（秒 / 分 / 小时）的高亮 */
function applyUnitSeg(id: string, unit: IntervalUnit): void {
  byId(id)
    .querySelectorAll<HTMLButtonElement>(".seg-btn")
    .forEach((b) => {
      const on = b.dataset.unit === unit;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
}

const win = getCurrentWindow();
const BASE_HINT =
  "支持 jpg / png / webp / gif / svg，仅保存在本机；上传会归入当前所选类型（“全部”时默认「待机」）。";

let config: AppConfig;
let assetFilter: FilterKey = "all";
let managing = false; // 素材库「管理」模式：开启时才显示删除按钮 + 支持多选批量删除
const selectedIds = new Set<string>(); // 管理模式下已勾选待删的素材 id（仅当前视图内有效）
let statusTimer: number | null = null;

async function main(): Promise<void> {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  // 关闭按钮：隐藏而非销毁，保持窗口单例可复用
  await win.onCloseRequested((e) => {
    e.preventDefault();
    void win.hide();
  });

  config = await loadConfig();
  setHiddenBuiltins(config.hiddenBuiltins);

  setupWindowControls();
  setupNav();
  setStatic();
  bindActiveCharacter();
  bindAppearance();
  bindBehavior();
  bindAutostart();
  bindUpdate();
  bindReminders();
  bindAssetControls();
  bindReset();

  syncControls();
  await setVersion();
  await initAutostart();
  await refreshOverview();
  await renderAvatarPicker();
  await renderSinglePicker();
  await renderGrid();

  // 素材若从别处变更也刷新网格 / 头像选择 / 单一动作选择
  await onAssetsChanged(async () => {
    await renderGrid();
    await renderAvatarPicker();
    await renderSinglePicker();
  });

  // 自动检查更新：静默执行，失败不打扰（仅手动点击「检查更新」时才报错）
  if (config.autoCheckUpdate) void checkForUpdate(true);
}

// ── 小工具 ───────────────────────────────────
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setImg(id: string, src: string): void {
  const el = document.getElementById(id) as HTMLImageElement | null;
  if (el) el.src = src;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** "HH:MM" → 两位的 { h, m }；格式非法时回退 00:00 */
function splitTime(atTime: string): { h: string; m: string } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(atTime);
  return m ? { h: m[1], m: m[2] } : { h: "00", m: "00" };
}

/** 输入框文本 → 夹取到 [0, hi] 的两位数字串（非纯数字按 0 处理） */
function clamp2(raw: string, hi: number): string {
  const t = raw.trim();
  const n = /^\d{1,2}$/.test(t) ? Number(t) : 0;
  return String(clampNum(n, 0, hi)).padStart(2, "0");
}

/** 素材分类的中文标签 */
function categoryLabel(cat: AssetCategory): string {
  if (cat === "drag") return "拖拽";
  return "待机";
}

/** 保存到本地并广播给桌宠窗口（即时生效），随后提示已保存 */
async function persist(): Promise<void> {
  await saveConfig(config);
  await emitConfigChanged(config);
  flashSaved();
}

/** 底部状态区短暂提示 */
function flashSaved(msg = "已保存 ✓", ok = true): void {
  const status = document.getElementById("opt-status");
  if (!status) return;
  status.textContent = msg;
  status.classList.toggle("opt-status--ok", ok);
  if (statusTimer !== null) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    status.textContent = "";
    status.classList.remove("opt-status--ok");
  }, 2000);
}

// ── 顶部标题栏：窗口控制 ──────────────────────
/** 最小化 / 最大化·还原 / 关闭。关闭 = 隐藏，保持窗口单例可复用 */
function setupWindowControls(): void {
  const maxBtn = document.getElementById("win-max");

  document
    .getElementById("win-min")
    ?.addEventListener("click", () => void win.minimize());
  document
    .getElementById("win-close")
    ?.addEventListener("click", () => void win.hide());
  maxBtn?.addEventListener("click", async () => {
    if (await win.isMaximized()) await win.unmaximize();
    else await win.maximize();
  });

  // 同步最大化/还原图标与提示（按钮、双击标题栏、系统贴靠均会触发 resize）
  const syncMaxState = async (): Promise<void> => {
    if (!maxBtn) return;
    const maxed = await win.isMaximized();
    maxBtn.classList.toggle("is-maximized", maxed);
    const label = maxed ? "还原" : "最大化";
    maxBtn.title = label;
    maxBtn.setAttribute("aria-label", label);
  };
  void syncMaxState();
  void win.onResized(() => void syncMaxState());
}

// ── 导航 / 静态信息 / 总览 ────────────────────
function setupNav(): void {
  const nav = byId("nav");
  const items = Array.from(
    nav.querySelectorAll<HTMLButtonElement>(".nav-item"),
  );
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".panel"));
  nav.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(
      ".nav-item",
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const key = btn.dataset.panel;
    items.forEach((i) => i.classList.toggle("is-active", i === btn));
    panels.forEach((p) =>
      p.classList.toggle("is-active", p.dataset.panel === key),
    );
    // 切回总览时重新回填，保证素材数 / 桌宠状态显示的是最新值
    if (key === "overview") void refreshOverview();
  });
}

/** 回填静态文案：总览标语 / 关于页作者（均取自 types.ts 常量，避免 html 里硬编码后漂移）；版本号见 setVersion() */
function setStatic(): void {
  setText("ov-slogan", SLOGAN);
  setText("about-author-character", AUTHORS.character);
  setText("about-author-program", AUTHORS.program);
}

/** 刷新总览页与顶部/关于头像（跟随当前人物与其选定头像），并回填简历式信息行 */
async function refreshOverview(): Promise<void> {
  const c = config.activeCharacter;
  setText("ov-name", CHARACTER_NAMES[c]);
  setText("ov-desc", CHARACTER_DESC[c]);
  const src = await getAvatarSrc(c, config.avatarIds[c]);
  setImg("ov-avatar", src);
  setImg("brand-avatar", src);
  setImg("about-avatar", src);

  // 信息行：当前人物的素材数 + 桌宠当前状态
  const items = await listAllForCharacter(c);
  setText("ov-assets", `${items.length} 个`);
  setText("ov-mode", BEHAVIOR_MODE_LABEL[config.behaviorMode]);
  setText("ov-size", `${config.petSize} px`);
  setText("ov-opacity", `${Math.round(config.petOpacity * 100)}%`);
}

/** 渲染头像选择：列出当前人物素材库缩略图，高亮已选，点击即设为头像 */
async function renderAvatarPicker(): Promise<void> {
  const picker = byId("avatar-picker");
  const c = config.activeCharacter;
  const items = await listAllForCharacter(c);
  const selectedId = config.avatarIds[c];
  picker.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "avatar-empty";
    empty.textContent = "该人物暂无素材";
    picker.appendChild(empty);
    return;
  }
  for (const item of items) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "avatar-opt";
    opt.dataset.id = item.id;
    opt.title = item.label ?? categoryLabel(item.category);
    opt.setAttribute("role", "radio");
    const selected = item.id === selectedId;
    opt.classList.toggle("is-selected", selected);
    opt.setAttribute("aria-checked", selected ? "true" : "false");

    const img = document.createElement("img");
    img.src = item.src;
    img.alt = item.label ?? "";
    img.draggable = false;
    img.loading = "lazy";
    opt.appendChild(img);

    opt.addEventListener("click", () => void selectAvatar(item.id));
    picker.appendChild(opt);
  }
}

/** 选定当前人物头像并即时生效（右键菜单 / 总览随之更新） */
async function selectAvatar(id: string): Promise<void> {
  const c = config.activeCharacter;
  if (config.avatarIds[c] === id) return;
  config.avatarIds[c] = id;
  // 仅切换高亮，避免整列重绘导致闪烁
  byId("avatar-picker")
    .querySelectorAll<HTMLButtonElement>(".avatar-opt")
    .forEach((b) => {
      const on = b.dataset.id === id;
      b.classList.toggle("is-selected", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  await persist();
  await refreshOverview();
}

// ── 用配置回填全部控件（初始化 & 恢复默认时复用） ──
function syncControls(): void {
  document
    .querySelectorAll<HTMLInputElement>('input[name="active-char"]')
    .forEach((r) => (r.checked = r.value === config.activeCharacter));
  setAssetChar(config.activeCharacter);

  byId<HTMLInputElement>("opt-size").value = String(config.petSize);
  setText("opt-size-val", String(config.petSize));

  const pct = Math.round(config.petOpacity * 100);
  byId<HTMLInputElement>("opt-opacity").value = String(pct);
  setText("opt-opacity-val", `${pct}%`);

  applyBehaviorMode(config.behaviorMode);
  // 频率：按存储单位换算显示，并同步分段控件高亮与输入框上下限
  const unit = config.idleIntervalUnit;
  applyUnitSeg("opt-interval-unit", unit);
  applyIntervalUnitBounds(unit);
  byId<HTMLInputElement>("opt-interval").value = String(
    msToUnit(config.idleIntervalMs, unit),
  );

  const autostart = document.getElementById(
    "opt-autostart",
  ) as HTMLInputElement | null;
  if (autostart) autostart.checked = config.autostart;

  const autoUpdate = document.getElementById(
    "opt-auto-update",
  ) as HTMLInputElement | null;
  if (autoUpdate) autoUpdate.checked = config.autoCheckUpdate;

  // 提醒：启用开关 / 间隔（或时间点）/ 关闭方式 / 文案
  for (const kind of REMINDER_KINDS) {
    const rc = config.reminders[kind];
    byId<HTMLInputElement>(`rm-${kind}-enabled`).checked = rc.enabled;
    byId<HTMLInputElement>(`rm-${kind}-text`).value = rc.text;
    if (REMINDER_META[kind].daily) {
      const { h, m } = splitTime(rc.atTime);
      byId<HTMLInputElement>(`rm-${kind}-hour`).value = h;
      byId<HTMLInputElement>(`rm-${kind}-minute`).value = m;
    } else {
      const interval = byId<HTMLInputElement>(`rm-${kind}-interval`);
      applyUnitSeg(`rm-${kind}-unit`, rc.intervalUnit);
      applyIntervalUnitBounds(
        rc.intervalUnit,
        interval,
        REMINDER_INTERVAL_BOUNDS,
      );
      interval.value = String(
        msToUnit(rc.intervalMs, rc.intervalUnit, REMINDER_INTERVAL_BOUNDS),
      );
    }
    applyReminderCloseMode(kind, rc.closeMode);
    applyReminderCollapse(kind, rc.enabled);
  }
}

// ── 外观：人物切换 / 大小 / 透明度 ────────────
function bindActiveCharacter(): void {
  const radios = document.querySelectorAll<HTMLInputElement>(
    'input[name="active-char"]',
  );
  radios.forEach((r) => {
    r.addEventListener("change", async () => {
      if (!r.checked) return;
      config.activeCharacter = r.value as CharacterKey;
      // 素材库默认跟随当前人物
      setAssetChar(config.activeCharacter);
      await persist();
      await refreshOverview();
      await renderAvatarPicker();
      await renderSinglePicker();
      await renderGrid();
    });
  });
}

function bindAppearance(): void {
  const size = byId<HTMLInputElement>("opt-size");
  const opacity = byId<HTMLInputElement>("opt-opacity");

  // 拖动时仅实时更新数值标签，释放（change）后再落盘 + 广播
  size.addEventListener("input", () => setText("opt-size-val", size.value));
  opacity.addEventListener("input", () =>
    setText("opt-opacity-val", `${opacity.value}%`),
  );

  size.addEventListener("change", async () => {
    config.petSize = clampNum(
      Number(size.value) || DEFAULT_CONFIG.petSize,
      20,
      200,
    );
    size.value = String(config.petSize);
    setText("opt-size-val", String(config.petSize));
    await persist();
  });
  opacity.addEventListener("change", async () => {
    const pct = clampNum(Math.round(Number(opacity.value) || 100), 30, 100);
    config.petOpacity = pct / 100;
    opacity.value = String(pct);
    setText("opt-opacity-val", `${pct}%`);
    await persist();
  });
}

// ── 行为：动作模式（单一 / 随机 / 顺序）+ 切换频率 ──
function bindBehavior(): void {
  const modeSeg = byId("behavior-mode");
  const interval = byId<HTMLInputElement>("opt-interval");
  const unitSeg = byId("opt-interval-unit");

  // 动作模式分段控件：单一动作 / 随机轮播 / 顺序轮播
  modeSeg.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest(
      ".seg-btn",
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const mode = btn.dataset.mode as BehaviorMode;
    if (mode !== "single" && mode !== "random" && mode !== "sequential") return;
    if (mode === config.behaviorMode) return;
    config.behaviorMode = mode;
    applyBehaviorMode(mode);
    await persist();
  });

  // 固定间隔：按当前单位输入数值，夹取到该单位上下限后换算为毫秒落盘（随机 / 顺序轮播时生效）
  interval.addEventListener("change", async () => {
    const unit = config.idleIntervalUnit;
    const v = clampNum(
      Math.round(Number(interval.value) || UNIT_BOUNDS[unit].min),
      UNIT_BOUNDS[unit].min,
      UNIT_BOUNDS[unit].max,
    );
    interval.value = String(v);
    config.idleIntervalMs = unitToMs(v, unit);
    await persist();
  });

  // 切换单位（秒 / 分 / 小时）：用新单位就近重新表示当前间隔并吸附到整单位，同步高亮与输入框上下限后落盘
  unitSeg.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest(
      ".seg-btn",
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const unit = btn.dataset.unit as IntervalUnit;
    if (unit !== "s" && unit !== "m" && unit !== "h") return;
    if (unit === config.idleIntervalUnit) return;
    config.idleIntervalUnit = unit;
    const v = msToUnit(config.idleIntervalMs, unit);
    applyIntervalUnitBounds(unit);
    applyUnitSeg("opt-interval-unit", unit);
    interval.value = String(v);
    config.idleIntervalMs = unitToMs(v, unit); // 吸附到整单位，保证显示与存储一致
    await persist();
  });
}

/** 按动作模式回填分段控件高亮，并显隐「指定动作」/「切换频率」行 */
function applyBehaviorMode(mode: BehaviorMode): void {
  byId("behavior-mode")
    .querySelectorAll<HTMLButtonElement>(".seg-btn")
    .forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  // 单一动作：显示造型选择、隐藏切换频率；随机 / 顺序：反之
  byId("single-row").classList.toggle("is-collapsed", mode !== "single");
  byId("freq-row").classList.toggle("is-collapsed", mode === "single");
}

/** 渲染「单一动作」造型选择：列出当前人物的待机造型（不含拖拽），高亮已选 */
async function renderSinglePicker(): Promise<void> {
  const picker = byId("single-picker");
  const c = config.activeCharacter;
  const items = (await listAllForCharacter(c)).filter(
    (it) => it.category !== "drag",
  );
  picker.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "avatar-empty";
    empty.textContent = "该人物暂无可选造型";
    picker.appendChild(empty);
    return;
  }
  // 选定失效（null 或指向已删 / 已隐藏素材）时，回退高亮第一个可选造型
  const selectedId = config.singleActionIds[c];
  const effectiveId = items.some((it) => it.id === selectedId)
    ? selectedId
    : items[0].id;
  for (const item of items) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "avatar-opt";
    opt.dataset.id = item.id;
    opt.title = item.label ?? categoryLabel(item.category);
    opt.setAttribute("role", "radio");
    const selected = item.id === effectiveId;
    opt.classList.toggle("is-selected", selected);
    opt.setAttribute("aria-checked", selected ? "true" : "false");

    const img = document.createElement("img");
    img.src = item.src;
    img.alt = item.label ?? "";
    img.draggable = false;
    img.loading = "lazy";
    opt.appendChild(img);

    opt.addEventListener("click", () => void selectSingleAction(item.id));
    picker.appendChild(opt);
  }
}

/** 选定「单一动作」造型并即时生效（仅切换高亮，避免整列重绘闪烁） */
async function selectSingleAction(id: string): Promise<void> {
  const c = config.activeCharacter;
  if (config.singleActionIds[c] === id) return;
  config.singleActionIds[c] = id;
  byId("single-picker")
    .querySelectorAll<HTMLButtonElement>(".avatar-opt")
    .forEach((b) => {
      const on = b.dataset.id === id;
      b.classList.toggle("is-selected", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  await persist();
}

// ── 软件：开机自动运行（Windows 注册表 Run 项，后端原生实现）──
function bindAutostart(): void {
  const toggle = document.getElementById(
    "opt-autostart",
  ) as HTMLInputElement | null;
  if (!toggle) return;
  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked;
    toggle.disabled = true; // 写注册表期间禁用，避免连点
    try {
      await invoke("set_autostart", { enabled });
      config.autostart = enabled;
      await persist();
    } catch (e) {
      console.error("set_autostart 失败:", e);
      toggle.checked = !enabled; // 写入失败则回滚开关
      flashSaved(`设置失败：${String(e)}`, false);
    } finally {
      toggle.disabled = false;
    }
  });
}

/** 以注册表真实状态回填开关（覆盖 syncControls 的乐观值，并静默同步 config） */
async function initAutostart(): Promise<void> {
  const toggle = document.getElementById(
    "opt-autostart",
  ) as HTMLInputElement | null;
  if (!toggle) return;
  try {
    const enabled = await invoke<boolean>("get_autostart");
    toggle.checked = enabled;
    if (config.autostart !== enabled) {
      config.autostart = enabled;
      await saveConfig(config); // 静默落盘，不弹“已保存”
    }
  } catch (e) {
    console.error("get_autostart 失败:", e); // 失败则保留 config 中的乐观值
  }
}

// ── 软件：版本检查与一键升级 ──────────────────
// 分发地址与验签公钥见 src-tauri/tauri.conf.json 的 plugins.updater：客户端只认那一个 endpoint，
// 安装包由发布方用私钥签名、此处用内置公钥校验，验签不通过不会安装。
// 界面状态写进 #upd-detail 的 data-state，CSS 据此显隐说明 / 进度条 / 操作按钮。

/** 更新流程状态 */
type UpdateState =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "error";

/** check() 命中的待安装更新；下载安装时复用，避免重复请求 */
let pendingUpdate: Update | null = null;

function bindUpdate(): void {
  const autoToggle = document.getElementById(
    "opt-auto-update",
  ) as HTMLInputElement | null;
  const checkBtn = document.getElementById(
    "btn-check-update",
  ) as HTMLButtonElement | null;
  const doBtn = document.getElementById(
    "btn-do-update",
  ) as HTMLButtonElement | null;
  const laterBtn = document.getElementById(
    "btn-update-later",
  ) as HTMLButtonElement | null;
  if (!autoToggle || !checkBtn || !doBtn || !laterBtn) return;

  autoToggle.addEventListener("change", async () => {
    config.autoCheckUpdate = autoToggle.checked;
    await persist();
  });

  checkBtn.addEventListener("click", () => void checkForUpdate());

  // 主操作按钮：有新版本时升级，出错时重试
  doBtn.addEventListener("click", () => {
    if (pendingUpdate) void installUpdate();
    else void checkForUpdate();
  });

  // 次操作按钮：有新版本时「稍后」，出错时「手动下载」跳发布页
  laterBtn.addEventListener("click", () => {
    if (byId("upd-detail").dataset.state === "error") {
      void openReleasePage();
      return;
    }
    pendingUpdate = null;
    setUpdateState("idle", "");
  });
}

/** 回填版本号：来源为 tauri.conf.json 的 version（经 Tauri API 读取），前端不再硬编码 */
async function setVersion(): Promise<void> {
  let version = "未知";
  try {
    version = await getVersion();
  } catch (e) {
    console.error("getVersion 失败:", e);
  }
  setText("about-version", version);
  setText("upd-current", `v${version}`);
}

/** 检查更新；silent 为 true（自动检查）时失败不打扰，仅恢复空闲态 */
async function checkForUpdate(silent = false): Promise<void> {
  setUpdateState("checking", "正在检查更新…");
  try {
    const update = await check();
    if (!update) {
      pendingUpdate = null;
      setUpdateState("upToDate", `已是最新版本 v${await getVersion()}`);
      return;
    }
    pendingUpdate = update;
    setUpdateState(
      "available",
      `发现新版本 v${update.version}，可一键升级`,
      (update.body ?? "").trim(),
    );
  } catch (e) {
    pendingUpdate = null;
    console.error("检查更新失败:", e);
    if (silent) {
      setUpdateState("idle", "");
      return;
    }
    setUpdateState("error", `检查更新失败：${describeUpdateError(e)}`);
  }
}

/** 下载并安装待更新，完成后重启应用 */
async function installUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update) return;

  // 中国大陆直连 GitHub 附件域名时，下载常在中途断流（reqwest 把它渲染成
  // "error decoding response body"，字面意思极具误导性）。这种中断是间歇性的，
  // 所以自动重试一次：失败后从头再下，多数情况第二次能过。
  const MAX_ATTEMPTS = 2;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const suffix = attempt > 1 ? `（第 ${attempt} 次尝试）` : "";
    let total = 0;
    let received = 0;
    let downloaded = false; // 收到 Finished 事件即视为下载完成
    setUpdateState("downloading", `正在下载 v${update.version}…${suffix}`);
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) {
            const pct = Math.round((received / total) * 100);
            setProgress(pct);
            setText("upd-msg", `正在下载 v${update.version}… ${pct}%${suffix}`);
          }
        } else {
          downloaded = true;
          setProgress(100); // Finished
        }
      });
      setUpdateState("installing", "正在安装，软件即将重启…");
      await relaunch();
      return;
    } catch (e) {
      lastError = e;
      console.error(`安装更新失败（第 ${attempt}/${MAX_ATTEMPTS} 次）:`, e);
      // 下载已完成才失败 → 问题出在安装阶段，重下整个包也没用，直接放弃
      if (downloaded) break;
      if (attempt < MAX_ATTEMPTS) {
        setUpdateState("downloading", "下载中断，正在重试…");
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      }
    }
  }

  setUpdateState("error", `更新失败：${describeUpdateError(lastError)}`);
}

/** 写入界面状态：同步 data-state、状态文案与更新说明，并按状态禁用 / 改写各按钮 */
function setUpdateState(state: UpdateState, msg: string, notes = ""): void {
  const detail = document.getElementById("upd-detail");
  const msgEl = document.getElementById("upd-msg");
  const notesEl = document.getElementById("upd-notes");
  if (!detail || !msgEl || !notesEl) return;

  detail.dataset.state = state;
  msgEl.textContent = msg;
  notesEl.textContent = notes;

  const busy =
    state === "checking" || state === "downloading" || state === "installing";
  const checkBtn = document.getElementById(
    "btn-check-update",
  ) as HTMLButtonElement | null;
  const doBtn = document.getElementById(
    "btn-do-update",
  ) as HTMLButtonElement | null;
  const laterBtn = document.getElementById(
    "btn-update-later",
  ) as HTMLButtonElement | null;
  if (checkBtn) {
    checkBtn.disabled = busy;
    checkBtn.textContent = state === "checking" ? "检查中…" : "检查更新";
  }
  if (doBtn) {
    doBtn.disabled = busy;
    doBtn.textContent = state === "error" ? "重试" : "立即升级";
  }
  if (laterBtn) {
    laterBtn.disabled = busy;
    laterBtn.textContent = state === "error" ? "手动下载" : "稍后";
  }
  if (state !== "downloading") setProgress(0); // 离开下载态即归零，避免残留满条
}

/** 下载进度条宽度（0 ~ 100） */
function setProgress(percent: number): void {
  const bar = document.getElementById("upd-bar");
  if (bar) bar.style.width = `${clampNum(percent, 0, 100)}%`;
}

/** 用系统默认浏览器打开 Release 页面（网络不通时的手动下载兜底） */
async function openReleasePage(): Promise<void> {
  try {
    await invoke("open_url", { url: RELEASE_PAGE_URL });
  } catch (e) {
    console.error("打开下载页失败:", e);
    flashSaved(`打开下载页失败：${String(e)}`, false);
  }
}

/**
 * 把更新失败原因转成可读文案；网络类失败额外提示可走手动下载。
 *
 * ⚠️ 必须显式覆盖 `error decoding response body`：reqwest 把「响应体流中断」和
 * 「JSON 解析失败」**都**渲染成这句话，字面意思（"解码响应体出错"）会让人以为是
 * 数据格式问题，实际几乎总是**下载中途断流**（实测：中国大陆直连 GitHub 附件域名）。
 */
function describeUpdateError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (
    /timeout|timed out|network|connect|dns|request|error sending|error decoding|decoding response|incomplete|unexpected eof|connection reset|connection closed|broken pipe/i.test(
      raw,
    )
  ) {
    return "网络中断，下载没完成。可点「手动下载」到发布页，或连上代理后重试";
  }
  return raw;
}

// ── 提醒：久坐 / 喝水 / 下班 ──────────────────
// 久坐与喝水为「间隔型」，下班为「每日定时型」；三者的会话框都可选自动关闭或手动关闭。
// 注意：处理函数里一律现读 config.reminders[kind]，不要在外层捕获引用——「恢复默认」会整体替换 config。
function bindReminders(): void {
  for (const kind of REMINDER_KINDS) {
    const enabled = byId<HTMLInputElement>(`rm-${kind}-enabled`);
    const text = byId<HTMLInputElement>(`rm-${kind}-text`);
    const seg = byId(`rm-${kind}-close`);

    // 启用开关：关闭时折叠其余配置行
    enabled.addEventListener("change", async () => {
      config.reminders[kind].enabled = enabled.checked;
      applyReminderCollapse(kind, enabled.checked);
      await persist();
    });

    // 关闭方式：自动关闭 / 手动关闭
    seg.addEventListener("click", async (e) => {
      const btn = (e.target as HTMLElement).closest(
        ".seg-btn",
      ) as HTMLButtonElement | null;
      if (!btn) return;
      const mode = btn.dataset.mode as ReminderCloseMode;
      if (mode !== "auto" && mode !== "manual") return;
      if (config.reminders[kind].closeMode === mode) return;
      config.reminders[kind].closeMode = mode;
      applyReminderCloseMode(kind, mode);
      await persist();
    });

    // 提醒文案：去空白并限长，留空则回退该类默认文案
    text.addEventListener("change", async () => {
      const v =
        text.value.trim().slice(0, REMINDER_TEXT_MAX) ||
        REMINDER_META[kind].defaultText;
      text.value = v;
      config.reminders[kind].text = v;
      await persist();
    });

    if (REMINDER_META[kind].daily) {
      // 每日定时型：时 / 分两个输入框各自夹取范围后合成 HH:MM 落盘
      const hour = byId<HTMLInputElement>(`rm-${kind}-hour`);
      const minute = byId<HTMLInputElement>(`rm-${kind}-minute`);
      const commitTime = async (): Promise<void> => {
        const h = clamp2(hour.value, 23);
        const m = clamp2(minute.value, 59);
        hour.value = h;
        minute.value = m;
        config.reminders[kind].atTime = `${h}:${m}`;
        await persist();
      };
      hour.addEventListener("change", () => void commitTime());
      minute.addEventListener("change", () => void commitTime());
    } else {
      // 间隔型：按当前单位输入数值，夹取到该单位上下限后换算为毫秒落盘
      const interval = byId<HTMLInputElement>(`rm-${kind}-interval`);
      const unitSeg = byId(`rm-${kind}-unit`);
      const bounds = REMINDER_INTERVAL_BOUNDS;

      interval.addEventListener("change", async () => {
        const unit = config.reminders[kind].intervalUnit;
        const v = clampNum(
          Math.round(Number(interval.value) || bounds[unit].min),
          bounds[unit].min,
          bounds[unit].max,
        );
        interval.value = String(v);
        config.reminders[kind].intervalMs = unitToMs(v, unit, bounds);
        await persist();
      });

      // 切换单位（秒 / 分 / 小时）：用新单位就近重新表示当前间隔并吸附到整单位
      unitSeg.addEventListener("click", async (e) => {
        const btn = (e.target as HTMLElement).closest(
          ".seg-btn",
        ) as HTMLButtonElement | null;
        if (!btn) return;
        const unit = btn.dataset.unit as IntervalUnit;
        if (unit !== "s" && unit !== "m" && unit !== "h") return;
        const rc = config.reminders[kind];
        if (rc.intervalUnit === unit) return;
        rc.intervalUnit = unit;
        const v = msToUnit(rc.intervalMs, unit, bounds);
        applyIntervalUnitBounds(unit, interval, bounds);
        applyUnitSeg(`rm-${kind}-unit`, unit);
        interval.value = String(v);
        rc.intervalMs = unitToMs(v, unit, bounds); // 吸附到整单位，保证显示与存储一致
        await persist();
      });
    }
  }
}

/** 回填某类提醒的「关闭方式」分段控件高亮 */
function applyReminderCloseMode(
  kind: ReminderKind,
  mode: ReminderCloseMode,
): void {
  byId(`rm-${kind}-close`)
    .querySelectorAll<HTMLButtonElement>(".seg-btn")
    .forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
}

/** 提醒未启用时折叠其配置行（间隔 / 时间 / 关闭方式 / 文案）；用 id 前缀匹配，间隔型与定时型各行互不干扰 */
function applyReminderCollapse(kind: ReminderKind, enabled: boolean): void {
  document
    .querySelectorAll<HTMLElement>(`[id^="rm-${kind}-row-"]`)
    .forEach((el) => el.classList.toggle("is-collapsed", !enabled));
}

// ── 素材库：选人物 / 类型筛选 / 上传 ──────────
// 人物选择改为按钮切换（radio）：读取 / 回填当前所选人物
function getAssetChar(): CharacterKey {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="asset-char"]:checked',
  );
  return (checked?.value as CharacterKey) ?? config.activeCharacter;
}

function setAssetChar(character: CharacterKey): void {
  document
    .querySelectorAll<HTMLInputElement>('input[name="asset-char"]')
    .forEach((r) => (r.checked = r.value === character));
}

function bindAssetControls(): void {
  const uploadBtn = byId<HTMLButtonElement>("btn-upload");
  const filter = byId("asset-filter");
  setText("asset-hint", BASE_HINT);

  // 仅切换素材库视图，不改变当前活动人物
  document
    .querySelectorAll<HTMLInputElement>('input[name="asset-char"]')
    .forEach((r) => {
      r.addEventListener("change", () => {
        if (r.checked) void renderGrid();
      });
    });

  filter.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(
      ".seg-btn",
    ) as HTMLButtonElement | null;
    if (!btn) return;
    setFilter((btn.dataset.cat as FilterKey) ?? "all");
  });

  uploadBtn.addEventListener("click", () => {
    // 上传归入当前所选类型；“全部”时默认待机
    const cat: AssetCategory = assetFilter === "all" ? "idle" : assetFilter;
    void doUpload(getAssetChar(), cat);
  });

  // 「管理」开关：切换删除按钮的显示（默认隐藏，避免常态露出影响美观）
  byId<HTMLButtonElement>("btn-manage").addEventListener("click", () =>
    setManaging(!managing),
  );
  // 批量：全选 / 删除所选
  byId<HTMLButtonElement>("btn-select-all").addEventListener("click", () =>
    selectAllVisible(),
  );
  byId<HTMLButtonElement>("btn-del-selected").addEventListener(
    "click",
    () => void deleteSelected(getAssetChar()),
  );
}

/** 切换素材库管理模式：显隐删除按钮 / 批量管理栏 + 同步按钮文案与激活态 */
function setManaging(next: boolean): void {
  managing = next;
  byId("asset-grid").classList.toggle("is-managing", managing);
  byId("asset-managebar").classList.toggle("is-open", managing);
  const btn = byId<HTMLButtonElement>("btn-manage");
  btn.textContent = managing ? "完成" : "管理";
  btn.classList.toggle("is-active", managing);
  btn.setAttribute("aria-pressed", managing ? "true" : "false");
  clearSelection(); // 进入/退出管理都从空选择开始
}

/** 切换单个素材的选中态 */
function toggleSelect(id: string, cell: HTMLElement): void {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    cell.classList.remove("is-selected");
  } else {
    selectedIds.add(id);
    cell.classList.add("is-selected");
  }
  updateManageBar();
}

/** 全选 / 取消全选（仅作用于当前可见单元格） */
function selectAllVisible(): void {
  const cells = Array.from(
    byId("asset-grid").querySelectorAll<HTMLElement>(".asset-cell"),
  ).filter((c) => !c.classList.contains("is-hidden"));
  const allSelected =
    cells.length > 0 && cells.every((c) => selectedIds.has(c.dataset.id ?? ""));
  cells.forEach((c) => {
    const id = c.dataset.id ?? "";
    if (allSelected) {
      selectedIds.delete(id);
      c.classList.remove("is-selected");
    } else {
      selectedIds.add(id);
      c.classList.add("is-selected");
    }
  });
  updateManageBar();
}

/** 清空所有选中并刷新管理栏 */
function clearSelection(): void {
  selectedIds.clear();
  byId("asset-grid")
    .querySelectorAll<HTMLElement>(".asset-cell.is-selected")
    .forEach((c) => c.classList.remove("is-selected"));
  updateManageBar();
}

/** 刷新管理栏：已选计数 / 删除所选可用性 / 全选按钮文案 */
function updateManageBar(): void {
  const n = selectedIds.size;
  setText("asset-selcount", `已选 ${n} 项`);
  byId<HTMLButtonElement>("btn-del-selected").disabled = n === 0;
  const visible = Array.from(
    byId("asset-grid").querySelectorAll<HTMLElement>(".asset-cell"),
  ).filter((c) => !c.classList.contains("is-hidden"));
  const allSel =
    visible.length > 0 &&
    visible.every((c) => selectedIds.has(c.dataset.id ?? ""));
  byId<HTMLButtonElement>("btn-select-all").textContent = allSel
    ? "取消全选"
    : "全选";
}

function setFilter(next: FilterKey): void {
  assetFilter = next;
  byId("asset-filter")
    .querySelectorAll<HTMLButtonElement>(".seg-btn")
    .forEach((b) => b.classList.toggle("is-active", b.dataset.cat === next));
  applyFilter();
  clearSelection(); // 切换筛选后视图变化，清空选择避免误删隐藏项
}

function applyFilter(): void {
  const grid = byId("asset-grid");
  const cells = Array.from(grid.querySelectorAll<HTMLElement>(".asset-cell"));
  let visible = 0;
  cells.forEach((c) => {
    const show = assetFilter === "all" || c.dataset.category === assetFilter;
    c.classList.toggle("is-hidden", !show);
    if (show) visible++;
  });
  let empty = grid.querySelector<HTMLElement>(".asset-empty");
  if (visible === 0) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "asset-empty";
      grid.appendChild(empty);
    }
    empty.textContent = cells.length === 0 ? "暂无素材" : "该类型下暂无素材";
  } else if (empty) {
    empty.remove();
  }
}

async function renderGrid(): Promise<void> {
  const grid = byId("asset-grid");
  const character = getAssetChar();
  const items = await listAllForCharacter(character);
  grid.innerHTML = "";
  for (const item of items) {
    const cell = document.createElement("div");
    cell.className = "asset-cell";
    cell.dataset.category = item.category;
    cell.dataset.id = item.id;

    const img = document.createElement("img");
    img.src = item.src;
    img.alt = item.label ?? "";
    img.draggable = false;
    img.loading = "lazy";
    cell.appendChild(img);

    const tag = document.createElement("span");
    tag.className = "asset-tag";
    tag.textContent = categoryLabel(item.category);
    cell.appendChild(tag);

    if (item.builtin) {
      const badge = document.createElement("span");
      badge.className = "asset-builtin";
      badge.textContent = "内置";
      cell.appendChild(badge);
    }

    // 勾选角标（管理模式显示）+ 点击单元格切换选中，用于批量删除
    const check = document.createElement("span");
    check.className = "asset-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    cell.appendChild(check);
    cell.addEventListener("click", () => {
      if (managing) toggleSelect(item.id, cell);
    });

    // 内置与自定义都可删除：内置为「隐藏」（不删文件，恢复默认可复原），自定义为真正删除
    const del = document.createElement("button");
    del.className = "asset-del";
    del.type = "button";
    del.textContent = "×";
    del.title = item.builtin
      ? "删除（内置素材，恢复默认可复原）"
      : "删除该素材";
    del.addEventListener("click", (e) => {
      e.stopPropagation(); // 不触发单元格选中
      void deleteAsset(item, character);
    });
    cell.appendChild(del);
    grid.appendChild(cell);
  }
  applyFilter();
  // 网格重建 → 清空旧选择并刷新管理栏计数
  selectedIds.clear();
  updateManageBar();
}

/**
 * 删除素材：内置=仅隐藏（记入 hiddenBuiltins，不删文件，恢复默认可复原），自定义=真正删除文件。
 * 约束：每个类别（待机/拖拽）都至少保留一个素材，删到该类别只剩一个时拒绝。命中当前头像则回退默认头像。
 */
async function deleteAsset(
  item: AssetItem,
  character: CharacterKey,
): Promise<void> {
  const items = await listAllForCharacter(character);
  const sameCategory = items.filter((it) => it.category === item.category);
  if (sameCategory.length <= 1) {
    setText(
      "asset-hint",
      `「${categoryLabel(item.category)}」至少保留一个素材，无法删除最后一个`,
    );
    window.setTimeout(() => setText("asset-hint", BASE_HINT), 2600);
    return;
  }

  if (item.builtin) {
    const hidden = config.hiddenBuiltins[character];
    if (!hidden.includes(item.id)) hidden.push(item.id);
    setHiddenBuiltins(config.hiddenBuiltins);
  } else {
    await removeCustomAsset(item.id);
  }

  // 命中当前头像则回退默认内置头像
  const avatarReset = config.avatarIds[character] === item.id;
  if (avatarReset) config.avatarIds[character] = null;
  // 命中「单一动作」选定造型则清空（桌宠端回退到第一个可用造型）
  if (config.singleActionIds[character] === item.id)
    config.singleActionIds[character] = null;

  await persist(); // 落盘 + 广播 configChanged（桌宠据 hiddenBuiltins 变化重载播放池）
  await renderGrid();
  if (character === config.activeCharacter) {
    await renderAvatarPicker();
    await renderSinglePicker();
    if (avatarReset) await refreshOverview();
  }
  await emitAssetsChanged(character); // 自定义删除需刷新桌宠缓存；内置隐藏亦触发重载（幂等）
}

/**
 * 批量删除选中素材：内置软隐藏 + 自定义真删，混合处理。
 * 约束：每个类别（待机/拖拽）删除后都至少保留一个素材，任一类别会被清空则拒绝；命中当前头像则回退默认。
 */
async function deleteSelected(character: CharacterKey): Promise<void> {
  if (selectedIds.size === 0) return;
  const items = await listAllForCharacter(character);
  const targets = items.filter((it) => selectedIds.has(it.id));
  // 按类别校验：从某类别删除后不能把该类别清空（所有类别必须保留一个）
  const emptied = (["idle", "drag"] as AssetCategory[]).filter((cat) => {
    const total = items.filter((it) => it.category === cat).length;
    const toDelete = targets.filter((it) => it.category === cat).length;
    return toDelete > 0 && total - toDelete < 1;
  });
  if (emptied.length > 0) {
    const names = emptied.map(categoryLabel).join("、");
    setText("asset-hint", `「${names}」至少保留一个素材，无法删除全部`);
    window.setTimeout(() => setText("asset-hint", BASE_HINT), 2600);
    return;
  }
  let avatarReset = false;
  for (const it of targets) {
    if (it.builtin) {
      const hidden = config.hiddenBuiltins[character];
      if (!hidden.includes(it.id)) hidden.push(it.id);
    } else {
      await removeCustomAsset(it.id);
    }
    if (config.avatarIds[character] === it.id) {
      config.avatarIds[character] = null;
      avatarReset = true;
    }
    // 命中「单一动作」选定造型则清空（桌宠端回退到第一个可用造型）
    if (config.singleActionIds[character] === it.id)
      config.singleActionIds[character] = null;
  }
  setHiddenBuiltins(config.hiddenBuiltins);
  await persist(); // 落盘 + 广播 configChanged（桌宠据 hiddenBuiltins 变化重载）
  await renderGrid(); // 内部会清空 selectedIds 并刷新管理栏
  if (character === config.activeCharacter) {
    await renderAvatarPicker();
    await renderSinglePicker();
    if (avatarReset) await refreshOverview();
  }
  await emitAssetsChanged(character);
}

async function doUpload(
  character: CharacterKey,
  category: AssetCategory,
): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "图片 / 动图", extensions: [...ALLOWED_EXTENSIONS] }],
    });
    if (!selected || typeof selected !== "string") return;
    setText("asset-hint", "上传中…");
    await addCustomAsset(character, category, selected);
    setFilter(category); // 切到对应类型，确保新素材可见
    await renderGrid();
    await emitAssetsChanged(character);
    setText("asset-hint", `已添加到「${categoryLabel(category)}」 ✓`);
    window.setTimeout(() => setText("asset-hint", BASE_HINT), 2600);
  } catch (e) {
    console.error(e);
    setText("asset-hint", `上传失败：${String(e)}`);
  }
}

// ── 底部：恢复默认 ────────────────────────────
function bindReset(): void {
  byId<HTMLButtonElement>("btn-reset").addEventListener("click", async () => {
    // 恢复出厂默认；保留桌宠当前摆放位置与开机自启。avatarIds / hiddenBuiltins 新建对象，避免共享 DEFAULT_CONFIG 引用
    config = {
      ...DEFAULT_CONFIG,
      petPosition: config.petPosition,
      avatarIds: { yier: null, bubu: null },
      hiddenBuiltins: { yier: [], bubu: [] },
      singleActionIds: { yier: null, bubu: null },
      autostart: config.autostart,
      reminders: makeDefaultReminders(), // 深重建，避免与 DEFAULT_CONFIG.reminders 共享引用
    };
    setHiddenBuiltins(config.hiddenBuiltins); // 清空隐藏 → 内置素材恢复显示
    syncControls();
    await refreshOverview();
    await renderAvatarPicker();
    await renderSinglePicker();
    await persist();
    await renderGrid();
    await emitAssetsChanged(config.activeCharacter); // 通知桌宠重载，复原被隐藏的内置造型
    flashSaved("已恢复默认设置");
  });
}

main().catch((e) => console.error("settings 初始化失败:", e));
