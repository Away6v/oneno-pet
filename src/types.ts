export type CharacterKey = "yier" | "bubu";
export type AssetCategory = "idle" | "drag";
/** 待机动作模式：single 单一动作(固定) / random 随机轮播 / sequential 顺序轮播 */
export type BehaviorMode = "single" | "random" | "sequential";
/** 切换频率的显示单位：s 秒 / m 分 / h 小时（仅影响设置页输入换算，存储恒为毫秒） */
export type IntervalUnit = "s" | "m" | "h";
/** 定时提醒种类：sit 久坐 / water 喝水 / offwork 下班 */
export type ReminderKind = "sit" | "water" | "offwork";
/** 提醒会话框的关闭方式：auto 自动收起 / manual 显示确认按钮，需用户点击关闭 */
export type ReminderCloseMode = "auto" | "manual";

/** 一个可播放动作（内置或自定义），一个文件 = 一个动作 */
export interface AssetItem {
  id: string;
  /** WebView 可直接加载的地址（内置为 /assets/<角色>/xxx；自定义为 convertFileSrc 结果） */
  src: string;
  category: AssetCategory;
  /** 是否内置素材（内置为软隐藏：只记入隐藏列表，不删文件） */
  builtin: boolean;
  label?: string;
}

/** 单类定时提醒的配置（久坐 / 喝水 / 下班各一份） */
export interface ReminderConfig {
  /** 是否启用该类提醒 */
  enabled: boolean;
  /** 触发间隔（毫秒，恒为毫秒；仅间隔型提醒使用） */
  intervalMs: number;
  /** 间隔的显示单位（秒 / 分 / 小时）；仅设置页换算显示用 */
  intervalUnit: IntervalUnit;
  /** 每天触发时间点 "HH:MM"（仅下班这类按固定时间的提醒使用） */
  atTime: string;
  /** 提醒文案（支持 \n 换行） */
  text: string;
  /** 会话框关闭方式：自动收起 / 手动确认 */
  closeMode: ReminderCloseMode;
}

export interface AppConfig {
  activeCharacter: CharacterKey;
  /** 每个角色选定的头像素材 id（null = 用默认内置头像）；用于右键菜单弹框与总览头像 */
  avatarIds: Record<CharacterKey, string | null>;
  /** 每个角色被「删除」（隐藏）的内置素材 id 列表；仅隐藏不删文件，恢复默认时清空即可复原 */
  hiddenBuiltins: Record<CharacterKey, string[]>;
  /** 桌宠窗口物理坐标；null 表示居中 */
  petPosition: { x: number; y: number } | null;
  /** 桌宠显示尺寸（逻辑像素，正方形边长） */
  petSize: number;
  /** 桌宠不透明度（0.3 ~ 1） */
  petOpacity: number;
  /** 待机动作模式：单一动作(固定) / 随机轮播 / 顺序轮播 */
  behaviorMode: BehaviorMode;
  /** 每个角色在「单一动作」模式下选定的造型 id（null = 用第一个可用造型）；为待机造型 */
  singleActionIds: Record<CharacterKey, string | null>;
  /** idle 自动切换间隔（毫秒，固定值，非区间随机） */
  idleIntervalMs: number;
  /** 切换频率的显示单位（秒 / 分 / 小时）；仅设置页换算显示用，idleIntervalMs 始终为毫秒 */
  idleIntervalUnit: IntervalUnit;
  /** 开机自启（Windows 注册表 HKCU\Run 项；以注册表为准，此字段仅作镜像/回填） */
  autostart: boolean;
  /** 打开设置窗口时是否静默检查更新（仅提示，不自动下载安装） */
  autoCheckUpdate: boolean;
  /** 三类定时提醒的配置（久坐 / 喝水 / 下班） */
  reminders: Record<ReminderKind, ReminderConfig>;
}

/** 提醒种类列表（固定顺序：设置页渲染与调度器遍历共用） */
export const REMINDER_KINDS: ReminderKind[] = ["sit", "water", "offwork"];

/** 各类提醒的元信息（名称 / 是否按固定时间触发 / 默认文案 / 确认按钮文案） */
export const REMINDER_META: Record<
  ReminderKind,
  {
    name: string;
    /** true = 每天固定时间点触发；false = 每隔一段时间触发 */
    daily: boolean;
    defaultText: string;
    /** 手动关闭时确认按钮的文案 */
    confirmText: string;
    /** 默认间隔（毫秒；daily 为 true 时忽略） */
    defaultIntervalMs: number;
    /** 默认触发时间 "HH:MM"（仅 daily 为 true 时使用） */
    defaultAtTime: string;
  }
> = {
  sit: {
    name: "久坐提醒",
    daily: false,
    defaultText: "坐了好久啦，起来活动一下下吧～",
    confirmText: "知道了",
    defaultIntervalMs: 45 * 60_000,
    defaultAtTime: "18:00",
  },
  water: {
    name: "喝水提醒",
    daily: false,
    defaultText: "该喝水啦，补充点水分吧～",
    confirmText: "好的",
    defaultIntervalMs: 60 * 60_000,
    defaultAtTime: "18:00",
  },
  offwork: {
    name: "下班提醒",
    daily: true,
    defaultText: "下班时间到啦，今天辛苦咯～",
    confirmText: "好的",
    defaultIntervalMs: 60 * 60_000,
    defaultAtTime: "18:00",
  },
};

/** 提醒间隔的数值上下限（按单位），设置页输入框与 normalize 夹取共用，避免两处打架 */
export const REMINDER_INTERVAL_BOUNDS: Record<IntervalUnit, { min: number; max: number }> = {
  s: { min: 60, max: 28_800 }, // 1 分 ~ 8 小时
  m: { min: 1, max: 480 }, //     1 分 ~ 8 小时
  h: { min: 1, max: 8 }, //       1 小时 ~ 8 小时
};
/** 提醒间隔的毫秒上下限（由 REMINDER_INTERVAL_BOUNDS 的「秒」档派生，供 normalize 夹取使用；
 *  单点定义避免两处边界漂移）。下限即全局最短间隔，设置页「提醒间隔」下方的「最小 1 分钟」提示对应此值。 */
export const REMINDER_INTERVAL_MIN_MS = REMINDER_INTERVAL_BOUNDS.s.min * 1000;
export const REMINDER_INTERVAL_MAX_MS = REMINDER_INTERVAL_BOUNDS.s.max * 1000;

/** 生成一份全新的提醒默认配置（每次新建对象，避免共享 DEFAULT_CONFIG 引用被就地改写） */
export function makeDefaultReminders(): Record<ReminderKind, ReminderConfig> {
  const out = {} as Record<ReminderKind, ReminderConfig>;
  for (const kind of REMINDER_KINDS) {
    const meta = REMINDER_META[kind];
    out[kind] = {
      enabled: false,
      intervalMs: meta.defaultIntervalMs,
      intervalUnit: "m",
      atTime: meta.defaultAtTime,
      text: meta.defaultText,
      closeMode: "auto",
    };
  }
  return out;
}

export const DEFAULT_CONFIG: AppConfig = {
  activeCharacter: "yier",
  avatarIds: { yier: null, bubu: null },
  hiddenBuiltins: { yier: [], bubu: [] },
  petPosition: null,
  petSize: 100,
  petOpacity: 1,
  behaviorMode: "random",
  singleActionIds: { yier: null, bubu: null },
  idleIntervalMs: 60000,
  idleIntervalUnit: "s",
  autostart: false,
  autoCheckUpdate: true,
  reminders: makeDefaultReminders(),
};

export const CHARACTER_NAMES: Record<CharacterKey, string> = {
  yier: "一二",
  bubu: "布布",
};

/** 角色一句话描述（设置页展示用） */
export const CHARACTER_DESC: Record<CharacterKey, string> = {
  yier: "one two妹",
  bubu: "no no哥",
};

/** 总览页标语 */
export const SLOGAN = "人生不如意，十有八九，常想一二";

// 版本号不在此硬编码：以 src-tauri/tauri.conf.json 的 version 为唯一来源，前端用 getVersion() 读取。

/** 更新分发地址（公开仓库的 Release 固定链接；与 tauri.conf.json 的 updater.endpoints 指向同一仓库） */
export const RELEASE_PAGE_URL = "https://github.com/Away6v/oneno-pet/releases/latest";

/** 作者信息（关于页展示用） */
export const AUTHORS = {
  /** 人物 / 美术作者 */
  character: "黄小B",
  /** 程序作者 */
  program: "Away",
} as const;

/** 会话框（气泡）内容载荷：跨窗口传给独立气泡窗口渲染 */
export interface SpeakPayload {
  /** 气泡文本（支持 \n 换行） */
  text: string;
  /** 是否显示图标（默认 false；提醒类通知置 true，如久坐/喝水） */
  icon?: boolean;
  /** 自动消失毫秒数（缺省则按文本长度估算） */
  durationMs?: number;
  /** 关闭方式：auto 自动收起（默认）/ manual 显示确认按钮，需用户点击才关闭 */
  closeMode?: ReminderCloseMode;
  /** 手动关闭时确认按钮的文案（缺省「知道了」） */
  confirmText?: string;
}

/** 主窗口定位完气泡窗口后，通知气泡窗口渲染并显示的载荷 */
export interface SpeakRenderPayload extends SpeakPayload {
  /** 气泡是否翻到桌宠下方（尖角朝上）；由主窗口按屏幕空间计算 */
  flipped: boolean;
  /** 桌宠中心相对气泡窗口左缘的横向位置（逻辑像素）；气泡贴边被夹时，尖角据此横移始终指向桌宠 */
  tailX?: number;
}

/** 下班倒计时面板的状态（主窗口持有并广播给菜单窗口与面板窗口） */
export interface CountdownState {
  /** 面板当前是否显示 */
  open: boolean;
  /** 目标下班时间 "HH:MM"（取自 reminders.offwork.atTime，与提醒开关无关） */
  atTime: string;
}

/** 放射菜单扇形的朝向：left 朝左（默认）/ right 朝右（贴近所在显示器左缘时翻转） */
export type FanSide = "left" | "right";

/** 弹出菜单前，主窗口把本次扇形朝向预先告知菜单窗口（窗口显示前就定好布局，避免显示后再重排） */
export interface MenuPreparePayload {
  /** 本次弹出的扇形朝向（主窗口按光标位置与所在显示器左缘算得） */
  side: FanSide;
}

/** 跨窗口事件名（仅字母 / 数字 / 连字符，符合 Tauri 规则） */
export const EVENTS = {
  configChanged: "oneno-config-changed",
  assetsChanged: "oneno-assets-changed",
  /** 请求弹出气泡（任意窗口 → 主窗口）；载荷为 SpeakPayload，由主窗口负责定位 */
  speak: "oneno-speak",
  /** 主窗口定位完毕 → 气泡窗口渲染并显示；载荷为 SpeakRenderPayload */
  speakRender: "oneno-speak-render",
  /** 立即收起气泡（如拖拽开始时） */
  speakHide: "oneno-speak-hide",
  /** 气泡已收起（气泡窗口 → 主窗口）；用于解除「手动会话框等待确认」状态 */
  speakClosed: "oneno-speak-closed",
  /** 请求切换下班倒计时面板显隐（菜单窗口 → 主窗口） */
  countdownToggle: "oneno-countdown-toggle",
  /** 主窗口广播面板状态（主窗口 → 菜单窗口 / 面板窗口）；载荷为 CountdownState */
  countdownState: "oneno-countdown-state",
  /** 询问面板当前状态（菜单窗口 → 主窗口）；菜单每次绽放时校正一次高亮 */
  countdownQuery: "oneno-countdown-query",
  /** 弹出菜单前（主窗口 → 菜单窗口）：预先告知扇形朝向并让菜单归零待绽放；载荷为 MenuPreparePayload */
  menuPrepare: "oneno-menu-prepare",
} as const;

/** 支持的素材扩展名（前端提示用；后端亦有校验） */
export const ALLOWED_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "svg",
  "gif",
] as const;
