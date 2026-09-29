import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_CONFIG,
  REMINDER_INTERVAL_MAX_MS,
  REMINDER_INTERVAL_MIN_MS,
  REMINDER_KINDS,
  makeDefaultReminders,
  type AppConfig,
  type ReminderConfig,
  type ReminderKind,
} from "../types";

/** 读取配置并与默认值合并；后端不存在时返回默认 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await invoke<Partial<AppConfig> | null>("load_config");
    // 经 normalize 生成全新对象（含独立的 avatarIds），避免共享 DEFAULT_CONFIG 引用
    return normalize(raw ?? {});
  } catch (e) {
    console.error("load_config 失败，使用默认配置:", e);
    return normalize({});
  }
}

/** 保存配置到本地 config.json */
export async function saveConfig(config: AppConfig): Promise<void> {
  try {
    await invoke("save_config", { config });
  } catch (e) {
    console.error("save_config 失败:", e);
  }
}

/** 合并默认值并做基本校验 / 夹取 */
export function normalize(raw: Partial<AppConfig>): AppConfig {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, ...raw };
  if (cfg.activeCharacter !== "yier" && cfg.activeCharacter !== "bubu") {
    cfg.activeCharacter = DEFAULT_CONFIG.activeCharacter;
  }

  // 头像选择：重建为独立对象（勿共享 DEFAULT_CONFIG.avatarIds 引用），仅接受字符串 id，否则置 null
  const rawAvatars = (raw.avatarIds ?? {}) as Partial<
    Record<"yier" | "bubu", unknown>
  >;
  cfg.avatarIds = {
    yier: typeof rawAvatars.yier === "string" ? rawAvatars.yier : null,
    bubu: typeof rawAvatars.bubu === "string" ? rawAvatars.bubu : null,
  };

  // 隐藏的内置素材：重建为独立对象（勿共享 DEFAULT_CONFIG 引用），仅接受字符串 id 数组
  const rawHidden = (raw.hiddenBuiltins ?? {}) as Partial<
    Record<"yier" | "bubu", unknown>
  >;
  const toIdArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  cfg.hiddenBuiltins = {
    yier: toIdArray(rawHidden.yier),
    bubu: toIdArray(rawHidden.bubu),
  };

  // 单一动作选定造型：重建独立对象（勿共享 DEFAULT_CONFIG 引用），仅接受字符串 id，否则置 null
  const rawSingle = (raw.singleActionIds ?? {}) as Partial<
    Record<"yier" | "bubu", unknown>
  >;
  cfg.singleActionIds = {
    yier: typeof rawSingle.yier === "string" ? rawSingle.yier : null,
    bubu: typeof rawSingle.bubu === "string" ? rawSingle.bubu : null,
  };
  cfg.petSize = clamp(Number(cfg.petSize) || DEFAULT_CONFIG.petSize, 20, 200);

  const rawOpacity = Number(cfg.petOpacity);
  cfg.petOpacity = clamp(
    Number.isFinite(rawOpacity) ? rawOpacity : DEFAULT_CONFIG.petOpacity,
    0.3,
    1,
  );

  // 动作模式：优先新字段；兼容迁移旧的 autoRotate 布尔（true→随机轮播 / false→单一动作）
  const legacyCfg = raw as Record<string, unknown>;
  const rawMode = legacyCfg.behaviorMode;
  if (
    rawMode === "single" ||
    rawMode === "random" ||
    rawMode === "sequential"
  ) {
    cfg.behaviorMode = rawMode;
  } else if (typeof legacyCfg.autoRotate === "boolean") {
    cfg.behaviorMode = legacyCfg.autoRotate ? "random" : "single";
  } else {
    cfg.behaviorMode = DEFAULT_CONFIG.behaviorMode;
  }
  // 丢弃旧的 autoRotate 字段，避免残留在持久化配置里
  delete (cfg as AppConfig & { autoRotate?: boolean }).autoRotate;

  // 切换间隔：优先新字段；兼容旧的 idleMinMs/idleMaxMs 配置（取中位数）；夹取 1s~24h
  const legacy = raw as Record<string, unknown>;
  const rawInterval = Number(legacy.idleIntervalMs);
  let interval = DEFAULT_CONFIG.idleIntervalMs;
  if (Number.isFinite(rawInterval) && rawInterval > 0) {
    interval = rawInterval;
  } else {
    const oldMin = Number(legacy.idleMinMs);
    const oldMax = Number(legacy.idleMaxMs);
    if (
      Number.isFinite(oldMin) &&
      oldMin > 0 &&
      Number.isFinite(oldMax) &&
      oldMax > 0
    ) {
      interval = Math.round((oldMin + oldMax) / 2);
    }
  }
  // 上限放宽到 24h，使「分 / 小时」单位可用；下限仍为 1s
  cfg.idleIntervalMs = clamp(interval, 1000, 86_400_000);
  // 频率显示单位：仅接受 s / m / h，否则回退默认「秒」
  const rawUnit = (raw as Record<string, unknown>).idleIntervalUnit;
  cfg.idleIntervalUnit =
    rawUnit === "s" || rawUnit === "m" || rawUnit === "h"
      ? rawUnit
      : DEFAULT_CONFIG.idleIntervalUnit;
  // 丢弃旧的区间字段（当前 AppConfig 已移除，显式声明为可选后再删除），避免残留在持久化配置里
  const cleaned = cfg as AppConfig & { idleMinMs?: number; idleMaxMs?: number };
  delete cleaned.idleMinMs;
  delete cleaned.idleMaxMs;

  const pos = cfg.petPosition;
  if (pos && (typeof pos.x !== "number" || typeof pos.y !== "number")) {
    cfg.petPosition = null;
  }
  cfg.autostart = Boolean(cfg.autostart);

  // 提醒配置：重建为独立对象（勿共享 DEFAULT_CONFIG.reminders 引用，否则设置页改写会污染默认值）
  cfg.reminders = normalizeReminders(raw.reminders);
  return cfg;
}

/** "HH:MM" 24 小时制时间点 */
const AT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 提醒文案长度上限（与设置页输入框 maxlength 保持一致） */
export const REMINDER_TEXT_MAX = 80;

/** 校验并重建三类提醒配置：字段缺失 / 类型非法一律回退该类默认值 */
function normalizeReminders(
  raw: unknown,
): Record<ReminderKind, ReminderConfig> {
  const out = makeDefaultReminders();
  const src = (raw ?? {}) as Record<string, unknown>;
  for (const kind of REMINDER_KINDS) {
    const def = out[kind];
    const item = src[kind];
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    def.enabled = Boolean(r.enabled);

    const ms = Number(r.intervalMs);
    if (Number.isFinite(ms)) {
      def.intervalMs = clamp(
        Math.round(ms),
        REMINDER_INTERVAL_MIN_MS,
        REMINDER_INTERVAL_MAX_MS,
      );
    }

    const unit = r.intervalUnit;
    if (unit === "s" || unit === "m" || unit === "h") def.intervalUnit = unit;

    if (typeof r.atTime === "string" && AT_TIME_RE.test(r.atTime))
      def.atTime = r.atTime;

    if (r.closeMode === "auto" || r.closeMode === "manual")
      def.closeMode = r.closeMode;

    const text =
      typeof r.text === "string"
        ? r.text.trim().slice(0, REMINDER_TEXT_MAX)
        : "";
    if (text) def.text = text;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
