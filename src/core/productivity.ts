import { invoke } from "@tauri-apps/api/core";
import type { FocusConfig, Task } from "../types";

export interface ProductivityData {
  tasks: Task[];
  focusSessions: Array<{ id: string; taskId: string | null; phase: string; minutes: number; endedAt: number }>;
}

const EMPTY: ProductivityData = { tasks: [], focusSessions: [] };

/** 读取本地待办与专注记录；旧版本没有文件时返回空数据。 */
export async function loadProductivity(): Promise<ProductivityData> {
  try {
    const raw = await invoke<Partial<ProductivityData> | null>("load_productivity");
    const tasks = Array.isArray(raw?.tasks) ? raw!.tasks.filter(isTask) : [];
    const focusSessions = Array.isArray(raw?.focusSessions) ? raw!.focusSessions.filter((x) => x && typeof x === "object") as ProductivityData["focusSessions"] : [];
    return { tasks, focusSessions };
  } catch (error) {
    console.error("读取本地业务数据失败:", error);
    return { ...EMPTY, tasks: [], focusSessions: [] };
  }
}

/** 原子保存本地业务数据。 */
export async function saveProductivity(data: ProductivityData): Promise<void> {
  await invoke("save_productivity", { data });
}

export function createTask(title: string, note = "", dueAt: string | null = null): Task {
  return {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: title.trim(),
    note: note.trim(),
    dueAt,
    completed: false,
    createdAt: Date.now(),
    completedAt: null,
  };
}

export function focusDuration(config: FocusConfig): number {
  if (config.phase === "shortBreak") return config.shortBreakMinutes * 60_000;
  if (config.phase === "longBreak") return config.longBreakMinutes * 60_000;
  return config.focusMinutes * 60_000;
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<Task>;
  return typeof task.id === "string" && typeof task.title === "string" && typeof task.completed === "boolean";
}
