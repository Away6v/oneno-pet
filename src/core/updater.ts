import { check, type Update } from "@tauri-apps/plugin-updater";

// 更新检查的公共部分：超时常量、Update 资源释放、自动检查节流、静默探测。
// 设置页（完整状态机 + 下载安装）与主窗口（启动时静默提示）共用这里，
// 避免两处各写一份 check 参数后漂移。

/**
 * 检查更新的请求超时（毫秒）。
 * ⚠️ 不设的话插件透传给 reqwest 的是「无总超时」，弱网下 check() 会一直挂着，
 * 界面就永远停在「检查中…」、按钮永久禁用 —— 只能关掉窗口重开。
 */
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;

/**
 * 下载安装包的超时（毫秒，含读完整响应体）。
 * 国内直连 GitHub 附件域名偏慢，给足 10 分钟；再久也不该由用户干等。
 */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 600_000;

/**
 * 自动检查的最小间隔（毫秒）。
 * 桌宠是常驻进程，启动与每次打开设置都会走到检查逻辑，
 * 不节流的话一天能发起几十次请求，既没必要也容易被 GitHub 限流。
 */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const LAST_AUTO_CHECK_KEY = "oneno-last-auto-check";

/** 自动检查是否已到期（距上次不足 AUTO_CHECK_INTERVAL_MS 就跳过） */
export function autoCheckDue(): boolean {
  try {
    const last = Number(window.localStorage.getItem(LAST_AUTO_CHECK_KEY) ?? 0);
    return !Number.isFinite(last) || Date.now() - last >= AUTO_CHECK_INTERVAL_MS;
  } catch {
    return true; // 隐私模式等读不到存储，按「到期」处理
  }
}

/** 记下本次自动检查时刻（无论成功失败都记，避免失败后被反复重试） */
export function markAutoChecked(): void {
  try {
    window.localStorage.setItem(LAST_AUTO_CHECK_KEY, String(Date.now()));
  } catch {
    /* 写不进去就退化成每次都查，不影响功能 */
  }
}

/** 探测到的新版本信息（不含 Update 句柄，调用方拿不到也就不会忘记释放） */
export interface UpdateInfo {
  version: string;
  /** 发布日期（RFC 3339），服务端没给则为空 */
  date?: string;
}

/**
 * 静默探测一次新版本：有新版本返回其信息，没有则返回 null。
 *
 * 无论哪种结果都会释放 Rust 侧资源 —— `Update` 继承自 `Resource`，
 * 持有服务端对象与已下载字节，且 `Resource` 没有 GC 兜底（只有 asyncDispose），
 * 不 close 就是实打实的泄漏。本函数把它关在里面，调用方无从遗漏。
 */
export async function probeUpdate(): Promise<UpdateInfo | null> {
  const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
  if (!update) return null;
  const info: UpdateInfo = { version: update.version, date: update.date };
  await closeUpdate(update);
  return info;
}

/**
 * 释放一个 Update 句柄。
 * 失败不抛：可能已被释放，或进程正在退出 —— 都不该影响调用方的流程。
 */
export async function closeUpdate(update: Update): Promise<void> {
  try {
    await update.close();
  } catch {
    /* 已释放 / 窗口正在关闭，忽略 */
  }
}
