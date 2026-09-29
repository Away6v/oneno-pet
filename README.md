# oneno-pet · 桌面宠物

一款轻量的 Windows 桌面宠物（桌宠）应用。内置两只卡通熊 **一二**（one two妹）与 **布布**（no no哥），可在桌面上自由拖动、按模式播放动作，还能上传自定义素材。个人 / 非商用，仅在检查更新时联网。

## 功能特性

- 透明无边框、始终置顶、不占用任务栏的桌宠窗口，可用左键拖动，位置自动记忆
- 待机动画：按设定间隔自动切换「待机」造型（单一固定 / 随机轮播 / 顺序轮播），频率支持秒 / 分 / 小时
- 拖拽反馈：拖动时展示「拖拽」造型并保持，松手后回到待机
- 角色切换：一二 / 布布，可更换角色头像
- 外观调节：宠物大小（20 ~ 200px）、透明度（30% ~ 100%）
- 右键放射扇环菜单：中心头像 / 下班倒计时 / 设置 / 退出
- 气泡会话框：桌宠会从头顶冒出气泡说话，闲置时随机碎碎念
- 定时提醒：久坐 / 喝水 / 下班三类提醒，支持「每隔一段时间」与「每天定时」两种触发方式，文案与关闭方式（自动 / 手动确认）均可自定义
- 下班倒计时面板：独立窗口贴在人物下方、中轴与人物对齐；桌宠贴近屏幕底部时自动翻到人物上方（气泡层级始终更高）。每秒刷新距离下班的剩余时间，右键菜单项即开关
- 自定义素材：为每个角色上传自己的图片或动图（待机 / 拖拽），支持批量管理
- 设置窗口：总览 / 宠物设置 / 素材库 / 软件 / 提醒 / 关于
- 系统托盘：显示隐藏桌宠、打开设置、退出
- 开机自启（Windows 注册表 Run 项）
- 检查更新：设置页可查看当前版本并一键升级（自动下载 → 验签 → 静默安装 → 重启），走公开仓库的 GitHub Releases，无需自建服务器
- 配置本地持久化，除检查更新外无任何网络请求

## 技术栈

- **Tauri v2**（Rust 后端 + 系统 WebView2，产物体积小、内存占用低）
- **Vite + TypeScript + 原生 DOM**（不引入前端框架）
- 极简依赖：前端仅 `@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-updater`、`@tauri-apps/plugin-process`；Rust 仅 `tauri`（启用 `protocol-asset`、`tray-icon`）、`tauri-plugin-single-instance`、`tauri-plugin-dialog`、`tauri-plugin-updater`、`tauri-plugin-process`、`serde`、`serde_json`
- 文件读写走 Rust 自定义命令（`std::fs`），未引入额外文件系统 / 存储插件

## 环境要求

- Windows 10 / 11
- Node.js ≥ 18
- Rust ≥ 1.77.2（稳定版工具链，需 MSVC 组件）
- WebView2 Runtime（Windows 11 自带；Windows 10 若缺失，安装包会自动引导下载）

## 目录结构

```
oneno-pet/
├── index.html            # 桌宠主窗口
├── menu.html             # 右键菜单窗口
├── speech.html           # 气泡会话框窗口
├── countdown.html        # 下班倒计时面板窗口
├── settings.html         # 设置窗口
├── public/assets/        # 内置素材（按角色分子目录）与图标源
├── .github/workflows/    # release.yml：推送 v* 标签触发构建 + 签名 + 建 Release 草稿
├── docs/                 # 说明文档（功能 / 架构 / 交互与资源 / 更新与发版）
├── scripts/              # 版本号与发布辅助脚本（Node ESM）
│   ├── version-files.mjs # 版本号定位 / 读写 / 一致性校验
│   ├── set-version.mjs   # 一条命令改完四处版本号
│   ├── sync-version.mjs  # 把 tauri.conf.json 的版本反写到其余文件
│   ├── build-desktop.mjs # 本地打包（自动注入签名私钥）
│   └── wait-release.mjs  # 盯 tag 触发的 CI 构建
├── src/
│   ├── main.ts           # 主窗口入口（渲染 / 拖拽 / 位置 / 气泡与倒计时定位 / 闲置碎碎念）
│   ├── menu.ts           # 菜单窗口入口（放射扇环）
│   ├── speech.ts         # 气泡窗口入口
│   ├── countdown.ts      # 倒计时面板入口（每秒刷新 / 到点态）
│   ├── settings.ts       # 设置窗口入口
│   ├── types.ts          # 公共类型与常量
│   ├── core/             # characters / config / bus / assetManager / reminders
│   ├── pet/              # PetRenderer / AnimationScheduler / DragController
│   └── styles/           # pet.css / menu.css / speech.css / countdown.css / settings.css
└── src-tauri/            # Rust 后端、Tauri 配置与能力声明
```

## 安装依赖

```bash
npm install
```

## 生成图标（首次必做）

Windows 上 `tauri-build` 会把应用图标编译进可执行文件的资源，因此**首次运行或打包前必须先生成图标**，否则会报错 `` `icons/icon.ico` not found ``。以 `public/assets/icon.png` 为源生成整套图标到 `src-tauri/icons/`：

```bash
npm run icons
```

> `tauri.conf.json` 的 `bundle.icon` 已预先配置好，生成图标后开发与打包都无需再改配置。
> 若提示源图过小，请用一张 1024×1024 的 PNG 作为源（可替换 `public/assets/icon.png`）。

## 开发运行

```bash
npm run tauri dev
```

首次运行会自动编译 Rust 后端（耗时较长，之后为增量编译，很快）。

## 构建与打包

```bash
npm run build:desktop
```

NSIS 安装包位于 `src-tauri/target/release/bundle/nsis/`，同时会生成 `*.exe.sig`（升级签名）。

> `latest.json` **不会在本地生成**，它由 CI 里的 `tauri-action` 产出并随 Release 上传。
> 所以「本地打个包 → 客户端就能检查到更新」是走不通的，验证升级必须走完整的发版流程。

> **不要直接用 `npm run tauri build`**。开启 `bundle.createUpdaterArtifacts` 后，打包会强制要求签名私钥，
> 未设置时报「A public key has been found, but no private key」。
> `npm run build:desktop` 会从 `~/.tauri/oneno-pet.key` 读私钥并注入所需环境变量；
> 若私钥不在该位置，用环境变量 `ONENO_SIGNING_KEY` 指定私钥文件路径。
> 私钥若设了密码，自行 `export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<密码>` 覆盖默认的空密码。
>
> 只做本地快速验证、不产出升级包时，可以 `npm run build:desktop -- --no-sign`。

## 发布新版本

发布由 GitHub Actions 自动完成，推送 `v*` 标签即触发。改版本号用一条命令搞定：

```bash
# 1. 改版本号：tauri.conf.json（权威）+ package.json + Cargo.toml + Cargo.lock 一次改完
npm run set-version -- 0.1.1
#    也可以不带参数，交互式输入：npm run set-version

# 2. 提交（tag 必须指向含版本号改动的 commit，所以要先提交再打 tag）
git add -A && git commit -m "chore: 版本号 0.1.1"
git push oneno-pet main

# 3. 打标签并推送，触发 CI
git tag v0.1.1
git push oneno-pet v0.1.1

# 4. 盯 CI 跑完（约 7~8 分钟），跑完会告诉你下一步该干嘛
npm run wait-release -- v0.1.1
```

> 本仓库的 remote 名是 **`oneno-pet`**，不是 `origin`。

流水线会构建安装包、用私钥签名、生成 `latest.json`，并创建一个 **Release 草稿**。
到 Releases 页面确认无误后**手动点 Publish release** —— 客户端读的 `releases/latest/` 只指向已发布的正式版。

> ⚠️ 草稿的展示页是**只读**的，上面没有发布按钮。要点草稿卡片右上角的**铅笔图标**进编辑页，
> 按钮在**表单最底部**。找不到就直开 `https://github.com/Away6v/oneno-pet/releases/edit/v0.1.1`。
> ⚠️ 推完 tag 后「标签页」立刻就有 `v0.1.1`，但「发行版页」要等 CI 跑完才有草稿，中间是空的 —— 这正常。
> **别手动在网页上建 Release**：那样会先造出一个没有产物的「空的 latest」，客户端会报
> `Could not fetch a valid release JSON from the remote`。

首次发布前需在仓库 Secrets 中配置 `TAURI_SIGNING_PRIVATE_KEY`（签名私钥），详见 `docs/04-更新与发版.md`。
完整发版步骤与排错见 `docs/04-更新与发版.md`。

## 数据与配置位置

应用数据保存在 `%APPDATA%\com.oneno.pet\`：

```
%APPDATA%\com.oneno.pet\
├── config.json              # 角色 / 头像 / 位置 / 大小 / 透明度 / 动作模式 / 切换间隔 / 定时提醒
└── assets\
    ├── manifest.json        # 自定义素材登记表
    ├── yier\                # 一二的自定义素材
    └── bubu\                # 布布的自定义素材
```

删除该目录即可恢复到初始状态（仅保留内置素材）。

## 自定义素材

在「设置 → 素材库」中选择人物与类型（待机 / 拖拽）后上传，支持 `jpg / jpeg / png / webp / gif / svg`。上传的文件会拷贝到上述数据目录，仅保存在本机。

- **待机（idle）**：空闲时按动作模式循环播放
- **拖拽（drag）**：拖动桌宠时展示，松手后回到待机

内置素材带「内置」角标，删除时只做**软隐藏**（不删文件，执行「恢复默认」即复原）；自定义素材则是真正删除。每个类别至少保留一个素材。开启「管理」后可批量勾选删除。

## 文档

`docs/` 下为本项目说明文档：

| 文档                          | 内容                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| `01-功能说明.md`              | 当前版本已实现的功能基线                                   |
| `02-架构与实现.md`            | 技术选型、窗口模型、模块设计、通信机制、存储与打包         |
| `03-交互与资源规范.md`        | 交互流程、菜单与气泡设计、视觉规范、素材与命名规范         |
| `04-更新与发版.md`            | 更新机制原理、**发版照着做**：逐步操作、检查清单、排错     |

## 常见问题

- **桌宠显示为空白 / 白块**：多为内置素材文件缺失，或 `src/core/characters.ts` 里登记的条目与实际文件名不符。核对 `public/assets/<角色>/` 下的文件是否齐全。
- **报错 `` `icons/icon.ico` not found ``**：首次 `tauri dev` 或打包前需先执行 `npm run icons` 生成图标（Windows 构建会把图标编入可执行文件）。
- **`npm run icons` 报 `Invalid PNG signature`**：`public/assets/icon.png` 并不是真正的 PNG（多为改了扩展名的 JPEG/WebP——看图工具靠内容识别能正常显示，但 `tauri icon` 只认 PNG 文件签名）。用「画图 / 照片」把它另存为真正的 PNG（建议 1024×1024）覆盖原文件后重试。
- **透明窗口出现黑边 / 黑底**：请确认使用较新的 WebView2 Runtime；本项目已设置 `transparent: true` 且窗口无阴影。
- **端口 1420 被占用**：Vite 使用固定端口 1420（`strictPort`）。关闭占用该端口的进程，或修改 `vite.config.ts` 与 `tauri.conf.json` 中的端口后重试。
- **气泡停在屏幕左上角**：气泡窗口的位置只在 `show()` 那一刻提交，必须「先 `setPosition` 再立刻 `show`」，不能先显示再移动（见 `src/main.ts` 的 `showSpeech`）。
- **右键菜单出屏 / 被裁**：菜单窗口尺寸 480×480 在 `src/main.ts`（`MENU_W` / `MENU_H`）与 `tauri.conf.json` 两处声明，调整时需同步。

## 许可与说明

个人 / 非商用项目，仅供学习与自用。除「检查更新」访问公开仓库的 GitHub Releases 外，不发起任何网络请求。内置人物素材版权归原作者（黄小B）所有。
