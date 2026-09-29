import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { CHARACTERS, assetUrl, avatarUrl } from "./characters";
import type { AssetCategory, AssetItem, CharacterKey } from "../types";

interface CustomAssetRecord {
  id: string;
  path: string;
  category: AssetCategory;
  character: CharacterKey;
}
type CustomAssetMap = Record<CharacterKey, CustomAssetRecord[]>;

// 自定义素材缓存（null 表示尚未加载）
let customCache: CustomAssetMap | null = null;

// 被「删除」（隐藏）的内置素材 id（按角色）。各窗口从 config 注入，随 configChanged 同步；
// 仅隐藏、不删磁盘文件，恢复默认时清空即可复原。
let hiddenBuiltins: Record<CharacterKey, string[]> = { yier: [], bubu: [] };

/** 注入隐藏内置列表（各窗口加载 / 收到 configChanged 后调用）；浅拷贝避免外部引用被内部改写 */
export function setHiddenBuiltins(
  map: Record<CharacterKey, string[]> | undefined,
): void {
  hiddenBuiltins = {
    yier: [...(map?.yier ?? [])],
    bubu: [...(map?.bubu ?? [])],
  };
}

function builtinItems(character: CharacterKey): AssetItem[] {
  const hidden = hiddenBuiltins[character] ?? [];
  return CHARACTERS[character].assets
    .filter((a) => !hidden.includes(a.id))
    .map((a) => ({
      id: a.id,
      src: assetUrl(character, a.file),
      category: a.category,
      builtin: true,
      label: a.label,
    }));
}

function customItems(character: CharacterKey): AssetItem[] {
  const list = customCache?.[character] ?? [];
  return list.map((r) => ({
    id: r.id,
    src: convertFileSrc(r.path),
    category: r.category,
    builtin: false,
  }));
}

/** 拉取并缓存全部自定义素材 */
export async function refreshCustomAssets(): Promise<void> {
  try {
    const res = await invoke<CustomAssetMap>("list_custom_assets");
    customCache = { yier: res?.yier ?? [], bubu: res?.bubu ?? [] };
  } catch (e) {
    console.error("list_custom_assets 失败:", e);
    customCache = { yier: [], bubu: [] };
  }
}

async function ensureLoaded(): Promise<void> {
  if (customCache === null) await refreshCustomAssets();
}

/**
 * 播放池：优先取指定类别；为空回退到 idle，再回退到全部。
 * 保证任何角色都有形象可显示（空池兜底）。
 */
export async function getPool(character: CharacterKey, category: AssetCategory): Promise<AssetItem[]> {
  await ensureLoaded();
  const all = [...builtinItems(character), ...customItems(character)];
  const wanted = all.filter((a) => a.category === category);
  if (wanted.length > 0) return wanted;
  const idle = all.filter((a) => a.category === "idle");
  if (idle.length > 0) return idle;
  return all;
}

/** 读取某角色全部素材（供设置页网格展示） */
export async function listAllForCharacter(character: CharacterKey): Promise<AssetItem[]> {
  await ensureLoaded();
  return [...builtinItems(character), ...customItems(character)];
}

/**
 * 解析角色头像地址：按选定的素材 id 在该角色素材库（内置 + 自定义）中查找，
 * 命中返回其 src；未选或对应素材已删除时回退默认内置头像。
 * 用于右键菜单弹框与设置页总览头像。
 */
export async function getAvatarSrc(
  character: CharacterKey,
  avatarId: string | null,
): Promise<string> {
  if (avatarId) {
    await ensureLoaded();
    const all = [...builtinItems(character), ...customItems(character)];
    const hit = all.find((a) => a.id === avatarId);
    if (hit) return hit.src;
  }
  return avatarUrl(character);
}

/** 上传：后端拷贝并登记，然后刷新缓存 */
export async function addCustomAsset(
  character: CharacterKey,
  category: AssetCategory,
  srcPath: string,
): Promise<void> {
  await invoke("add_custom_asset", { character, category, srcPath });
  await refreshCustomAssets();
}

/** 删除自定义素材，然后刷新缓存 */
export async function removeCustomAsset(id: string): Promise<void> {
  await invoke("remove_custom_asset", { id });
  await refreshCustomAssets();
}
