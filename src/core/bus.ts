import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EVENTS,
  type AppConfig,
  type CharacterKey,
  type CountdownState,
  type FanSide,
  type MenuPreparePayload,
  type SpeakPayload,
  type SpeakRenderPayload,
} from "../types";

// 跨窗口事件封装：全局 emit 会广播到所有窗口，listen 在各窗口接收。

export function emitConfigChanged(config: AppConfig): Promise<void> {
  return emit(EVENTS.configChanged, config);
}

export function onConfigChanged(cb: (config: AppConfig) => void): Promise<UnlistenFn> {
  return listen<AppConfig>(EVENTS.configChanged, (e) => cb(e.payload));
}

export function emitAssetsChanged(character: CharacterKey): Promise<void> {
  return emit(EVENTS.assetsChanged, { character });
}

export function onAssetsChanged(cb: (character: CharacterKey) => void): Promise<UnlistenFn> {
  return listen<{ character: CharacterKey }>(EVENTS.assetsChanged, (e) => cb(e.payload.character));
}

// ── 会话框（气泡）──
// 定位职责收敛到主窗口：任意窗口 emitSpeak → 主窗口 onSpeak 计算坐标并摆好气泡窗口
// → emitSpeakRender 通知气泡窗口渲染并显示。气泡窗口不再跨窗口查询主窗口几何。
export function emitSpeak(payload: SpeakPayload): Promise<void> {
  return emit(EVENTS.speak, payload);
}

export function onSpeak(cb: (payload: SpeakPayload) => void): Promise<UnlistenFn> {
  return listen<SpeakPayload>(EVENTS.speak, (e) => cb(e.payload));
}

export function emitSpeakRender(payload: SpeakRenderPayload): Promise<void> {
  return emit(EVENTS.speakRender, payload);
}

export function onSpeakRender(cb: (payload: SpeakRenderPayload) => void): Promise<UnlistenFn> {
  return listen<SpeakRenderPayload>(EVENTS.speakRender, (e) => cb(e.payload));
}

export function emitSpeakHide(): Promise<void> {
  return emit(EVENTS.speakHide);
}

export function onSpeakHide(cb: () => void): Promise<UnlistenFn> {
  return listen(EVENTS.speakHide, () => cb());
}

// 气泡已收起（气泡窗口 → 主窗口）：主窗口据此解除「手动会话框等待确认」状态。
// 由气泡窗口的 hide() 统一广播，覆盖按钮点击 / 自动到时 / 被强制收起等全部关闭路径。
export function emitSpeakClosed(): Promise<void> {
  return emit(EVENTS.speakClosed);
}

export function onSpeakClosed(cb: () => void): Promise<UnlistenFn> {
  return listen(EVENTS.speakClosed, () => cb());
}

// ── 下班倒计时面板 ──
// 状态由常驻的主窗口持有：菜单窗口只发 toggle / query，主窗口统一广播 state；
// 面板窗口据此启停计时，菜单窗口据此高亮菜单项。
export function emitCountdownToggle(): Promise<void> {
  return emit(EVENTS.countdownToggle);
}

export function onCountdownToggle(cb: () => void): Promise<UnlistenFn> {
  return listen(EVENTS.countdownToggle, () => cb());
}

export function emitCountdownState(state: CountdownState): Promise<void> {
  return emit(EVENTS.countdownState, state);
}

export function onCountdownState(cb: (state: CountdownState) => void): Promise<UnlistenFn> {
  return listen<CountdownState>(EVENTS.countdownState, (e) => cb(e.payload));
}

export function emitCountdownQuery(): Promise<void> {
  return emit(EVENTS.countdownQuery);
}

export function onCountdownQuery(cb: () => void): Promise<UnlistenFn> {
  return listen(EVENTS.countdownQuery, () => cb());
}

// ── 放射菜单 ──
// 弹出前先定朝向：主窗口在 show 之前把本次扇形朝向告知菜单窗口，
// 让菜单在窗口显示前就按最终朝向建好扇面并归零 —— 显示后不再重排，从根上消除「闪一下再重显」。
export function emitMenuPrepare(side: FanSide): Promise<void> {
  return emit(EVENTS.menuPrepare, { side } satisfies MenuPreparePayload);
}

export function onMenuPrepare(cb: (side: FanSide) => void): Promise<UnlistenFn> {
  return listen<MenuPreparePayload>(EVENTS.menuPrepare, (e) =>
    cb(e.payload.side),
  );
}
