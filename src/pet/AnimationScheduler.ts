import type { AssetItem, BehaviorMode, CharacterKey } from "../types";
import { getPool, listAllForCharacter } from "../core/assetManager";
import type { PetRenderer } from "./PetRenderer";

export interface SchedulerConfig {
  /** idle 自动切换间隔（毫秒，固定值，非区间随机）；仅随机/顺序轮播时生效 */
  idleIntervalMs: number;
  /** 动作模式：单一动作(固定) / 随机轮播 / 顺序轮播 */
  mode: BehaviorMode;
  /** 单一动作模式下选定的造型 id（当前角色）；null 或失效时回退到第一个可用造型 */
  singleActionId: string | null;
}

/**
 * 动画调度：待机时按「动作模式」展示造型——
 * 单一动作固定一张、随机轮播防重复随机切换、顺序轮播按序循环（后两者按固定间隔）；
 * 拖拽时展示 drag 造型并保持，松手后回到待机造型。隐藏时可 pause 以降低占用。
 */
export class AnimationScheduler {
  private renderer: PetRenderer;
  private character: CharacterKey;
  private cfg: SchedulerConfig;
  private idlePool: AssetItem[] = [];
  private dragPool: AssetItem[] = [];
  /** 单一动作可选池 = 待机造型（不含拖拽）；用于解析选定造型 */
  private singlePool: AssetItem[] = [];
  private timer: number | null = null;
  private running = false;
  private dragging = false;
  private lastIdleId: string | null = null;
  /** 顺序轮播的当前索引（作用于 idlePool 的可用子集） */
  private seqIndex = 0;
  private badIds = new Set<string>();

  constructor(renderer: PetRenderer, character: CharacterKey, cfg: SchedulerConfig) {
    this.renderer = renderer;
    this.character = character;
    this.cfg = cfg;
    this.renderer.onError((item) => this.badIds.add(item.id));
  }

  async start(): Promise<void> {
    this.running = true;
    await this.reloadPools(); // 载入播放池后按当前模式展示
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
  }

  /** 窗口隐藏：暂停定时器（保留 running 状态） */
  pause(): void {
    this.clearTimers();
  }

  /** 窗口恢复：若仍在运行且无挂起定时器则按当前模式重新展示 / 排程 */
  resume(): void {
    if (this.dragging) return; // 拖拽保持造型期间不打断
    if (this.running && this.timer === null) this.applyMode();
  }

  setConfig(cfg: SchedulerConfig): void {
    const prev = this.cfg;
    this.cfg = cfg;
    if (!this.running || this.dragging) return;
    if (prev.mode !== cfg.mode) {
      // 切换模式：重置顺序索引，按新模式立即展示 + 排程
      this.seqIndex = 0;
      this.applyMode();
    } else if (cfg.mode === "single") {
      // 单一模式内仅换了选定造型 → 立即更新（无定时器）
      if (cfg.singleActionId !== prev.singleActionId) this.showSingle();
    } else if (cfg.idleIntervalMs !== prev.idleIntervalMs) {
      // 随机 / 顺序：仅间隔变化 → 用新间隔重排下一次（不立即换造型）
      this.scheduleNext();
    }
  }

  async setCharacter(character: CharacterKey): Promise<void> {
    this.character = character;
    this.lastIdleId = null;
    this.seqIndex = 0;
    await this.reloadPools(); // 内部按当前模式重新展示
  }

  /** 素材变更后重新加载当前角色播放池，并按需刷新当前展示 */
  async reloadPools(): Promise<void> {
    this.idlePool = await getPool(this.character, "idle");
    this.dragPool = await getPool(this.character, "drag");
    // 单一动作可选池 = 待机造型（不含拖拽）；为空时回退到 idle 池
    const all = await listAllForCharacter(this.character);
    this.singlePool = all.filter((a) => a.category !== "drag");
    if (this.singlePool.length === 0) this.singlePool = this.idlePool;
    // 预载全部造型，确保切换 / 拖拽的交叉淡入即时、平滑（无首次加载停顿）
    this.renderer.preload([...this.singlePool, ...this.dragPool]);
    if (!this.running || this.dragging) return;
    if (this.cfg.mode === "single") {
      // 单一模式：始终校正为选定造型（可能新增 / 被删）
      this.showSingle();
    } else {
      // 随机 / 顺序：仅当前造型失效时才补救，避免打断正常轮播节奏
      const stillValid =
        this.lastIdleId !== null &&
        this.idlePool.some((a) => a.id === this.lastIdleId && !this.badIds.has(a.id));
      if (!stillValid) this.applyMode();
    }
  }

  /** 拖拽开始：打断当前动作，随机展示一个「拖拽」造型并保持，暂停待机切换 */
  showDrag(): void {
    if (!this.running) return;
    this.dragging = true;
    this.clearTimers();
    const pick = this.randomFrom(this.dragPool, null);
    if (pick) this.renderer.show(pick);
  }

  /**
   * 拖拽结束：保持拖拽前的造型，不因松手而切换。
   * 单一动作复位到选定造型；随机 / 顺序恢复拖拽前造型并继续按间隔排程（松手瞬间不切）。
   */
  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (!this.running) return;
    if (this.cfg.mode === "single") {
      this.showSingle();
    } else {
      // 恢复到拖拽前正在展示的造型（lastIdleId 在拖拽期间不变）
      this.restoreIdle();
      this.scheduleNext();
    }
  }

  /** 按当前模式展示造型并排定后续切换（若需要） */
  private applyMode(): void {
    this.clearTimers();
    if (!this.running) return;
    if (this.cfg.mode === "single") {
      this.showSingle();
    } else if (this.cfg.mode === "sequential") {
      this.showSequentialCurrent();
      this.scheduleNext();
    } else {
      this.showRandomIdle();
      this.scheduleNext();
    }
  }

  /** 单一动作：展示选定造型（失效则回退首个可用造型）并保持 */
  private showSingle(): void {
    const usable = this.singlePool.filter((a) => !this.badIds.has(a.id));
    const chosen =
      (this.cfg.singleActionId
        ? usable.find((a) => a.id === this.cfg.singleActionId)
        : undefined) ??
      usable[0] ??
      this.usableIdle()[0];
    if (chosen) {
      this.lastIdleId = chosen.id;
      this.renderer.show(chosen);
    }
  }

  private showRandomIdle(): void {
    const pick = this.randomFrom(this.idlePool, this.lastIdleId);
    if (pick) {
      this.lastIdleId = pick.id;
      this.renderer.show(pick);
    }
  }

  /** 顺序轮播：展示当前索引造型（不前进） */
  private showSequentialCurrent(): void {
    const usable = this.usableIdle();
    if (usable.length === 0) return;
    if (this.seqIndex >= usable.length) this.seqIndex = 0;
    const pick = usable[this.seqIndex];
    this.lastIdleId = pick.id;
    this.renderer.show(pick);
  }

  /** 顺序轮播：前进到下一个造型并展示 */
  private showSequentialNext(): void {
    const usable = this.usableIdle();
    if (usable.length === 0) return;
    this.seqIndex = (this.seqIndex + 1) % usable.length;
    const pick = usable[this.seqIndex];
    this.lastIdleId = pick.id;
    this.renderer.show(pick);
  }

  /** 回到上一次的 idle 造型（用于随机 / 顺序模式拖拽结束时的复位） */
  private restoreIdle(): void {
    const item = this.idlePool.find((a) => a.id === this.lastIdleId) ?? null;
    if (item) this.renderer.show(item);
    else this.showRandomIdle();
  }

  private scheduleNext(): void {
    this.clearTimers();
    if (!this.running) return;
    if (this.cfg.mode !== "random" && this.cfg.mode !== "sequential") return;
    const delay = Math.max(0, this.cfg.idleIntervalMs);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.cfg.mode === "sequential") this.showSequentialNext();
      else this.showRandomIdle();
      this.scheduleNext();
    }, delay);
  }

  /** 可用的 idle 造型子集（排除加载失败的） */
  private usableIdle(): AssetItem[] {
    return this.idlePool.filter((a) => !this.badIds.has(a.id));
  }

  private randomFrom(pool: AssetItem[], avoidId: string | null): AssetItem | null {
    const usable = pool.filter((a) => !this.badIds.has(a.id));
    if (usable.length === 0) return null;
    if (usable.length === 1) return usable[0];
    let pick = usable[Math.floor(Math.random() * usable.length)];
    let guard = 0;
    while (avoidId && pick.id === avoidId && guard < 8) {
      pick = usable[Math.floor(Math.random() * usable.length)];
      guard++;
    }
    return pick;
  }

  private clearTimers(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
