import type { AssetCategory, CharacterKey } from "../types";

export interface BuiltinAsset {
  id: string;
  /** public/assets/<character>/ 下的文件名 */
  file: string;
  category: AssetCategory;
  label: string;
}

export interface CharacterDef {
  name: string;
  /** 头像文件（右键菜单 / 总览用），取自该角色内置素材 */
  avatarFile: string;
  assets: BuiltinAsset[];
}

/**
 * Vite 把 public/ 原样发布到根路径。内置素材按角色分子目录存放，
 * 故以 /assets/<character>/<file> 引用。
 */
export function assetUrl(character: CharacterKey, file: string): string {
  return `/assets/${character}/${file}`;
}

// 内置素材登记（对应 public/assets/<character>/ 下真实文件，见 docs/04）
export const CHARACTERS: Record<CharacterKey, CharacterDef> = {
  yier: {
    name: "一二",
    avatarFile: "yier-daze.webp",
    assets: [
      {
        id: "yier-daze",
        file: "yier-daze.webp",
        category: "idle",
        label: "呆萌",
      },
      {
        id: "yier-read",
        file: "yier-read.webp",
        category: "idle",
        label: "看书",
      },
      {
        id: "yier-phone",
        file: "yier-phone.webp",
        category: "idle",
        label: "玩手机",
      },
      {
        id: "yier-hat",
        file: "yier-hat.webp",
        category: "idle",
        label: "黄帽",
      },
      { id: "yier-hi", file: "yier-hi.png", category: "drag", label: "举高高" },
      {
        id: "yier-peek",
        file: "yier-peek.webp",
        category: "idle",
        label: "探头",
      },
      {
        id: "yier-pupu",
        file: "yier-pupu.webp",
        category: "idle",
        label: "噗噗",
      },
      {
        id: "yier-sleepy",
        file: "yier-sleepy.webp",
        category: "idle",
        label: "犯困",
      },
      {
        id: "yier-runaway",
        file: "yier-runaway.webp",
        category: "idle",
        label: "离家出走",
      },
      {
        id: "yier-dress",
        file: "yier-dress.webp",
        category: "idle",
        label: "碎花裙",
      },
      {
        id: "yier-rose",
        file: "yier-rose.webp",
        category: "idle",
        label: "玫瑰",
      },
      {
        id: "yier-swing",
        file: "yier-swing.webp",
        category: "idle",
        label: "荡秋千",
      },
      {
        id: "yier-desk",
        file: "yier-desk.webp",
        category: "idle",
        label: "趴桌眨眼",
      },
      {
        id: "yier-giraffe",
        file: "yier-giraffe.webp",
        category: "idle",
        label: "长颈鹿装",
      },
      {
        id: "yier-hood",
        file: "yier-hood.webp",
        category: "idle",
        label: "连帽装",
      },
      {
        id: "yier-surrender",
        file: "yier-surrender.webp",
        category: "idle",
        label: "投降",
      },
      {
        id: "yier-work",
        file: "yier-work.webp",
        category: "idle",
        label: "下班啦",
      },
      {
        id: "yier-scooter",
        file: "yier-scooter.webp",
        category: "idle",
        label: "滑板车",
      },
      {
        id: "yier-horn",
        file: "yier-horn.webp",
        category: "idle",
        label: "喇叭",
      },
      {
        id: "yier-fairy",
        file: "yier-fairy.webp",
        category: "idle",
        label: "仙女下凡",
      },
      {
        id: "yier-cuddle",
        file: "yier-cuddle.webp",
        category: "idle",
        label: "依偎",
      },
      {
        id: "yier-hug",
        file: "yier-hug.webp",
        category: "idle",
        label: "抱抱",
      },
      {
        id: "yier-poke",
        file: "yier-poke.webp",
        category: "idle",
        label: "戳一戳",
      },
      {
        id: "yier-ride",
        file: "yier-ride.webp",
        category: "idle",
        label: "扑抱",
      },
      {
        id: "yier-missyou",
        file: "yier-missyou.webp",
        category: "idle",
        label: "想你",
      },
      {
        id: "yier-cola",
        file: "yier-cola.gif",
        category: "idle",
        label: "喝可乐",
      },
      {
        id: "yier-quilt",
        file: "yier-quilt.gif",
        category: "idle",
        label: "晒被子",
      },
      {
        id: "yier-nowork",
        file: "yier-nowork.gif",
        category: "idle",
        label: "不想上班",
      },
      {
        id: "yier-kiss",
        file: "yier-kiss.gif",
        category: "idle",
        label: "亲亲",
      },
      {
        id: "yier-taxi",
        file: "yier-taxi.gif",
        category: "idle",
        label: "出租车",
      },
      {
        id: "yier-doze",
        file: "yier-doze.gif",
        category: "idle",
        label: "打盹",
      },
      {
        id: "yier-mop",
        file: "yier-mop.gif",
        category: "idle",
        label: "拖地",
      },
      {
        id: "yier-fafa",
        file: "yier-fafa.gif",
        category: "idle",
        label: "送花",
      },
      {
        id: "yier-laundry",
        file: "yier-laundry.gif",
        category: "idle",
        label: "洗衣服",
      },
      {
        id: "yier-wash",
        file: "yier-wash.gif",
        category: "idle",
        label: "搓衣服",
      },
      {
        id: "yier-game",
        file: "yier-game.gif",
        category: "idle",
        label: "玩游戏",
      },
      {
        id: "yier-clap",
        file: "yier-clap.gif",
        category: "idle",
        label: "鼓掌",
      },
      {
        id: "yier-hugself",
        file: "yier-hugself.gif",
        category: "idle",
        label: "抱自己",
      },
      {
        id: "yier-tongue",
        file: "yier-tongue.gif",
        category: "idle",
        label: "吐舌",
      },
      {
        id: "yier-pack",
        file: "yier-pack.gif",
        category: "idle",
        label: "打包",
      },
      {
        id: "yier-serve",
        file: "yier-serve.gif",
        category: "idle",
        label: "为人民服务",
      },
      {
        id: "yier-sleep",
        file: "yier-sleep.gif",
        category: "idle",
        label: "睡觉",
      },
      {
        id: "yier-magic",
        file: "yier-magic.gif",
        category: "idle",
        label: "准备施法",
      },
      {
        id: "yier-book",
        file: "yier-book.gif",
        category: "idle",
        label: "读书",
      },
      {
        id: "yier-milktea",
        file: "yier-milktea.gif",
        category: "idle",
        label: "喝奶茶",
      },
      {
        id: "yier-behind",
        file: "yier-behind.gif",
        category: "idle",
        label: "背手",
      },
      {
        id: "yier-shy",
        file: "yier-shy.gif",
        category: "idle",
        label: "害羞",
      },
      {
        id: "yier-fee",
        file: "yier-fee.gif",
        category: "idle",
        label: "收保护费",
      },
      {
        id: "yier-cover",
        file: "yier-cover.gif",
        category: "idle",
        label: "捂脸",
      },
      {
        id: "yier-polish",
        file: "yier-polish.gif",
        category: "idle",
        label: "擦车",
      },
      {
        id: "yier-sugar",
        file: "yier-sugar.gif",
        category: "idle",
        label: "全糖去冰",
      },
      {
        id: "yier-feed",
        file: "yier-feed.gif",
        category: "idle",
        label: "喂食",
      },
      {
        id: "yier-giverose",
        file: "yier-giverose.gif",
        category: "idle",
        label: "送玫瑰",
      },
      {
        id: "yier-pose",
        file: "yier-pose.gif",
        category: "idle",
        label: "站姿",
      },
      {
        id: "yier-vacuum",
        file: "yier-vacuum.gif",
        category: "idle",
        label: "吸尘",
      },
      {
        id: "yier-moto",
        file: "yier-moto.gif",
        category: "idle",
        label: "骑摩托",
      },
      {
        id: "yier-getoff",
        file: "yier-getoff.gif",
        category: "idle",
        label: "收工",
      },
      {
        id: "yier-tired",
        file: "yier-tired.gif",
        category: "idle",
        label: "加班累",
      },
      {
        id: "yier-back",
        file: "yier-back.gif",
        category: "idle",
        label: "背影",
      },
      {
        id: "yier-pout",
        file: "yier-pout.gif",
        category: "idle",
        label: "撇嘴",
      },
      {
        id: "yier-cheer",
        file: "yier-cheer.gif",
        category: "idle",
        label: "加油",
      },
      {
        id: "yier-rope",
        file: "yier-rope.gif",
        category: "idle",
        label: "跳绳",
      },
      {
        id: "yier-peck",
        file: "yier-peck.gif",
        category: "idle",
        label: "贴贴",
      },
      {
        id: "yier-comb",
        file: "yier-comb.gif",
        category: "idle",
        label: "打扮",
      },
      {
        id: "yier-bottle",
        file: "yier-bottle.gif",
        category: "idle",
        label: "奶瓶",
      },
      {
        id: "yier-lollipop",
        file: "yier-lollipop.gif",
        category: "idle",
        label: "棒棒糖",
      },
      {
        id: "yier-crown",
        file: "yier-crown.gif",
        category: "idle",
        label: "皇冠",
      },
    ],
  },
  bubu: {
    name: "布布",
    avatarFile: "bubu-daze.webp",
    assets: [
      {
        id: "bubu-daze",
        file: "bubu-daze.webp",
        category: "idle",
        label: "呆萌",
      },
      {
        id: "bubu-read",
        file: "bubu-read.webp",
        category: "idle",
        label: "看书",
      },
      {
        id: "bubu-phone",
        file: "bubu-phone.webp",
        category: "idle",
        label: "玩手机",
      },
      {
        id: "bubu-hat",
        file: "bubu-hat.webp",
        category: "idle",
        label: "粉帽",
      },
      { id: "bubu-hi", file: "bubu-hi.png", category: "drag", label: "举高高" },
      {
        id: "bubu-melon",
        file: "bubu-melon.webp",
        category: "idle",
        label: "吃西瓜",
      },
      {
        id: "bubu-sleepy",
        file: "bubu-sleepy.webp",
        category: "idle",
        label: "犯困",
      },
      {
        id: "bubu-dress",
        file: "bubu-dress.webp",
        category: "idle",
        label: "碎花裙",
      },
      {
        id: "bubu-rose",
        file: "bubu-rose.webp",
        category: "idle",
        label: "玫瑰",
      },
      {
        id: "bubu-swing",
        file: "bubu-swing.webp",
        category: "idle",
        label: "荡秋千",
      },
      {
        id: "bubu-desk",
        file: "bubu-desk.webp",
        category: "idle",
        label: "趴桌眨眼",
      },
      {
        id: "bubu-cow",
        file: "bubu-cow.webp",
        category: "idle",
        label: "奶牛装",
      },
      {
        id: "bubu-hood",
        file: "bubu-hood.webp",
        category: "idle",
        label: "连帽装",
      },
      {
        id: "bubu-surrender",
        file: "bubu-surrender.webp",
        category: "idle",
        label: "投降",
      },
      {
        id: "bubu-work",
        file: "bubu-work.webp",
        category: "idle",
        label: "下班啦",
      },
      {
        id: "bubu-scooter",
        file: "bubu-scooter.webp",
        category: "idle",
        label: "滑板车",
      },
      {
        id: "bubu-dry",
        file: "bubu-dry.webp",
        category: "idle",
        label: "吹头发",
      },
      {
        id: "bubu-fairy",
        file: "bubu-fairy.webp",
        category: "idle",
        label: "仙男下凡",
      },
      {
        id: "bubu-cuddle",
        file: "bubu-cuddle.webp",
        category: "idle",
        label: "依偎",
      },
      {
        id: "bubu-hug",
        file: "bubu-hug.webp",
        category: "idle",
        label: "抱抱",
      },
      {
        id: "bubu-poke",
        file: "bubu-poke.webp",
        category: "idle",
        label: "戳一戳",
      },
      {
        id: "bubu-ride",
        file: "bubu-ride.webp",
        category: "idle",
        label: "扑抱",
      },
      {
        id: "bubu-missyou",
        file: "bubu-missyou.webp",
        category: "idle",
        label: "想你",
      },
      {
        id: "bubu-quilt",
        file: "bubu-quilt.gif",
        category: "idle",
        label: "晒被子",
      },
      {
        id: "bubu-bottle",
        file: "bubu-bottle.gif",
        category: "idle",
        label: "奶瓶",
      },
      {
        id: "bubu-mop",
        file: "bubu-mop.gif",
        category: "idle",
        label: "拖地",
      },
      {
        id: "bubu-fold",
        file: "bubu-fold.gif",
        category: "idle",
        label: "叠衣服",
      },
      {
        id: "bubu-huh",
        file: "bubu-huh.gif",
        category: "idle",
        label: "就你？",
      },
      {
        id: "bubu-giverose",
        file: "bubu-giverose.gif",
        category: "idle",
        label: "送玫瑰",
      },
      {
        id: "bubu-peck",
        file: "bubu-peck.gif",
        category: "idle",
        label: "贴贴",
      },
      {
        id: "bubu-crown",
        file: "bubu-crown.gif",
        category: "idle",
        label: "皇冠",
      },
      {
        id: "bubu-laundry",
        file: "bubu-laundry.gif",
        category: "idle",
        label: "洗衣服",
      },
      {
        id: "bubu-wash",
        file: "bubu-wash.gif",
        category: "idle",
        label: "搓衣服",
      },
      {
        id: "bubu-call",
        file: "bubu-call.gif",
        category: "idle",
        label: "打电话",
      },
      {
        id: "bubu-embrace",
        file: "bubu-embrace.gif",
        category: "idle",
        label: "拥抱",
      },
      {
        id: "bubu-polish",
        file: "bubu-polish.gif",
        category: "idle",
        label: "擦车",
      },
      {
        id: "bubu-pout",
        file: "bubu-pout.gif",
        category: "idle",
        label: "鼓嘴",
      },
      {
        id: "bubu-pose",
        file: "bubu-pose.gif",
        category: "idle",
        label: "站姿",
      },
      {
        id: "bubu-doze",
        file: "bubu-doze.gif",
        category: "idle",
        label: "打盹",
      },
      {
        id: "bubu-feed",
        file: "bubu-feed.gif",
        category: "idle",
        label: "喂食",
      },
      {
        id: "bubu-lollipop",
        file: "bubu-lollipop.gif",
        category: "idle",
        label: "棒棒糖",
      },
    ],
  },
};

export function avatarUrl(character: CharacterKey): string {
  return assetUrl(character, CHARACTERS[character].avatarFile);
}
