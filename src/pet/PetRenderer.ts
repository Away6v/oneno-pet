import type { AssetItem } from "../types";

/**
 * 双缓冲渲染：两个 <img> 交替淡入。先用独立 Image 预载，加载完成后再切换，
 * 减少闪烁 / 白屏。加载失败通过 onError 上报，供调度器临时剔除坏图。
 */
export class PetRenderer {
  private imgs: [HTMLImageElement, HTMLImageElement];
  private front = 0;
  private currentId: string | null = null;
  private onErrorCb: ((item: AssetItem) => void) | null = null;
  private preloaded = new Set<string>();

  constructor(a: HTMLImageElement, b: HTMLImageElement) {
    this.imgs = [a, b];
    a.classList.add("is-front");
    b.classList.remove("is-front");
  }

  onError(cb: (item: AssetItem) => void): void {
    this.onErrorCb = cb;
  }

  setSize(px: number): void {
    for (const img of this.imgs) {
      img.style.width = `${px}px`;
      img.style.height = `${px}px`;
    }
  }

  /**
   * 预载素材到浏览器缓存（解码后驻留），使后续 show() 的交叉淡入即时触发、无加载停顿。
   * 对拖拽尤为重要：拖拽造型平时不展示，首次拖拽若现载会有明显卡顿。
   */
  preload(items: AssetItem[]): void {
    for (const it of items) {
      if (this.preloaded.has(it.src)) continue;
      this.preloaded.add(it.src);
      const img = new Image();
      img.src = it.src;
    }
  }

  /** 展示某素材；预载完成后交叉淡入到后台缓冲并交换 */
  show(item: AssetItem): void {
    if (item.id === this.currentId) return;
    const backIndex = this.front === 0 ? 1 : 0;
    const back = this.imgs[backIndex];

    const loader = new Image();
    loader.onload = () => {
      back.src = item.src;
      this.currentId = item.id;
      this.swap();
    };
    loader.onerror = () => {
      console.warn("素材加载失败，跳过:", item.src);
      this.onErrorCb?.(item);
    };
    loader.src = item.src;
  }

  private swap(): void {
    const backIndex = this.front === 0 ? 1 : 0;
    this.imgs[backIndex].classList.add("is-front");
    this.imgs[this.front].classList.remove("is-front");
    this.front = backIndex;
  }
}
