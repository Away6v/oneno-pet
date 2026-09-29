import {
  REMINDER_KINDS,
  REMINDER_META,
  type AppConfig,
  type ReminderKind,
  type SpeakPayload,
} from "../types";

// 定时提醒调度器（跑在常驻的主窗口里，与闲置碎碎念同层）。
// 用「按墙钟时间比较」的 tick 轮询而非长 setTimeout：休眠唤醒后首个 tick 即能补触发，
// 且配置热更新只需重算 nextAt，无需管理一堆定时器句柄。

/** 轮询间隔：到期后最多延迟这么久触发（分钟级提醒足够） */
const TICK_MS = 15_000;

/** 同一 tick 内多个提醒同时到期时的先后（越靠前越先弹） */
const PRIORITY: ReminderKind[] = ["offwork", "water", "sit"];

/** 算出「下一次 HH:MM」的时间戳；今天已过则顺延到明天（倒计时面板亦复用此算法） */
export function nextDailyAt(atTime: string, now: number): number {
  const [hh, mm] = atTime.split(":").map(Number);
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  // 用 setDate 顺延而非 +86400000，避免夏令时等造成整点偏移
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export interface ReminderScheduler {
  /** 应用最新配置；首次调用即启动轮询，之后按需重算各类提醒的下次触发时刻 */
  setConfig(config: AppConfig): void;
  /** 停止轮询 */
  stop(): void;
}

/**
 * 创建调度器。`fire` 负责真正弹出会话框并返回是否弹成功：
 * 返回 false（桌宠被隐藏、或正有未关闭的手动会话框）时不推进 nextAt，下个 tick 重试。
 */
export function createReminderScheduler(
  fire: (payload: SpeakPayload) => Promise<boolean>,
): ReminderScheduler {
  const state = {} as Record<ReminderKind, { key: string; nextAt: number | null }>;
  for (const kind of REMINDER_KINDS) state[kind] = { key: "", nextAt: null };

  let cfgRef: AppConfig | null = null;
  let timer: number | null = null;
  let started = false;
  let firing = false;

  function setConfig(next: AppConfig): void {
    cfgRef = next;
    const now = Date.now();
    for (const kind of REMINDER_KINDS) {
      const rc = next.reminders[kind];
      // 指纹只含「影响触发时刻」的字段：改文案 / 关闭方式不会把倒计时重置掉
      const key = JSON.stringify({ e: rc.enabled, i: rc.intervalMs, t: rc.atTime });
      const st = state[kind];
      if (st.key === key) continue;
      st.key = key;
      if (!rc.enabled) {
        st.nextAt = null; // 关闭：清空排程
      } else {
        // 打开 / 改间隔 / 改时间点：从当前时刻重新起算，不立即弹
        st.nextAt = REMINDER_META[kind].daily ? nextDailyAt(rc.atTime, now) : now + rc.intervalMs;
      }
    }
    if (!started) {
      started = true;
      timer = window.setInterval(() => void tick(), TICK_MS);
    }
  }

  function stop(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    started = false;
  }

  async function tick(): Promise<void> {
    if (firing || !cfgRef) return;
    const now = Date.now();
    // 收集所有到期项，按到期时间升序（并列时按固定优先级）；本 tick 只弹第一个，
    // 其余保持到期态留待下个 tick —— 手动会话框未关闭时天然形成「排队」而非被覆盖。
    const due = REMINDER_KINDS.map((k) => ({ k, at: state[k].nextAt }))
      .filter((x): x is { k: ReminderKind; at: number } => x.at !== null && now >= x.at)
      .sort((a, b) => a.at - b.at || PRIORITY.indexOf(a.k) - PRIORITY.indexOf(b.k));
    if (due.length === 0) return;

    const kind = due[0].k;
    const rc = cfgRef.reminders[kind];
    const meta = REMINDER_META[kind];

    firing = true;
    let shown = false;
    try {
      shown = await fire({
        text: rc.text,
        icon: true,
        closeMode: rc.closeMode,
        confirmText: meta.confirmText,
      });
    } catch (e) {
      console.error(`提醒「${meta.name}」弹出失败:`, e);
    } finally {
      firing = false;
    }

    if (!shown) return; // 没弹成功：保持到期态，下个 tick 重试
    const at = Date.now();
    state[kind].nextAt = meta.daily ? nextDailyAt(rc.atTime, at) : at + rc.intervalMs;
  }

  return { setConfig, stop };
}
