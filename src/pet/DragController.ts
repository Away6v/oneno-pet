import type { Window } from "@tauri-apps/api/window";

const DRAG_THRESHOLD = 5; // px：小于该位移视为点击

export interface DragCallbacks {
  /** 位移小于阈值、判定为点击时触发（可选；桌宠单击无动作，可不提供） */
  onClick?: () => void;
  /** 越过阈值、开始拖动窗口时触发（用于切到「拖拽」造型） */
  onDragStart?: () => void;
  /** 拖动结束（松开左键）时触发，用于回到待机造型。仅由真实的鼠标释放信号触发，与计时无关 */
  onDragEnd?: () => void;
}

/**
 * 左键按住拖动窗口；用位移阈值区分点击与拖拽。
 * 超过阈值即调用原生 startDragging，此后由系统接管本次拖动，不再判定为点击。
 *
 * 拖拽结束的判定完全基于真实鼠标事件、绝不依赖计时器：
 *   1) window mouseup；
 *   2) 原生拖动吞掉 mouseup 时，靠拖拽中收到的 mousemove（左键已松开 buttons&1===0）补收尾；
 *   3) 极端情况下靠下一次 mousedown 兜底复位。
 * 这样「切换/停顿的时间」永远不会影响一次拖拽（拖拽造型保持到真正松手为止）。
 */
export class DragController {
  private win: Window;
  private el: HTMLElement;
  private cb: DragCallbacks;
  private startX = 0;
  private startY = 0;
  private pressing = false;
  private dragging = false;

  constructor(win: Window, el: HTMLElement, callbacks: DragCallbacks) {
    this.win = win;
    this.el = el;
    this.cb = callbacks;
    this.el.addEventListener("mousedown", this.onDown);
    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("mouseup", this.onUp);
  }

  private onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return; // 仅左键
    // 上一次拖拽若因原生拖动吞掉释放事件而未收尾，这里先补一次结束，避免状态残留
    if (this.dragging) this.finishDrag();
    this.pressing = true;
    this.dragging = false;
    this.startX = e.screenX;
    this.startY = e.screenY;
  };

  private onMove = (e: MouseEvent): void => {
    if (this.dragging) {
      // 原生拖动可能吞掉 mouseup：拖拽中一旦发现左键已松开，立刻收尾（不依赖任何计时）
      if ((e.buttons & 1) === 0) this.finishDrag();
      return;
    }
    if (!this.pressing) return;
    const dx = Math.abs(e.screenX - this.startX);
    const dy = Math.abs(e.screenY - this.startY);
    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
      this.pressing = false;
      this.dragging = true;
      this.cb.onDragStart?.();
      void this.win.startDragging();
    }
  };

  private onUp = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    if (this.dragging) {
      this.finishDrag();
    } else if (this.pressing) {
      this.pressing = false;
      this.cb.onClick?.();
    }
  };

  /** 结束一次拖拽（幂等）：仅由真实鼠标释放信号调用，通知调用方回到待机造型 */
  private finishDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.pressing = false;
    this.cb.onDragEnd?.();
  }
}
