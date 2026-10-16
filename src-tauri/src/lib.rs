use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
#[derive(Default)]
struct DevtoolsState {
    enabled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    registered: tauri::async_runtime::Mutex<std::collections::HashSet<String>>,
}

/// 自定义素材记录（写入 manifest.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CustomAsset {
    id: String,
    character: String,
    category: String,
    path: String,
}

const ALLOWED_EXT: [&str; 6] = ["jpg", "jpeg", "png", "webp", "svg", "gif"];

fn now_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("u_{}", nanos)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("assets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(assets_dir(app)?.join("manifest.json"))
}

fn read_manifest(app: &AppHandle) -> Result<Vec<CustomAsset>, String> {
    let p = manifest_path(app)?;
    if !p.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_manifest(app: &AppHandle, items: &[CustomAsset]) -> Result<(), String> {
    let p = manifest_path(app)?;
    let raw = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    atomic_write(&p, raw.as_bytes())
}

/// 退出应用
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// 读取配置；不存在时返回 null
#[tauri::command]
fn load_config(app: AppHandle) -> Result<Option<Value>, String> {
    let p = data_dir(&app)?.join("config.json");
    if !p.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(v))
}

/// 写入配置
#[tauri::command]
fn save_config(app: AppHandle, config: Value) -> Result<(), String> {
    let dir = data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("config.json");
    let raw = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    atomic_write(&p, raw.as_bytes())?;
    // 所有配置保存入口都同步权限，恢复默认时也立即禁用 F12。
    #[cfg(windows)]
    app.state::<DevtoolsState>().enabled.store(
        config["allowDevTools"].as_bool().unwrap_or(false),
        std::sync::atomic::Ordering::SeqCst,
    );
    Ok(())
}

/// 使用同目录临时文件替换，避免进程中断时留下半份配置。
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        let backup = path.with_extension("bak");
        let _ = fs::copy(path, backup);
        // Windows 的 rename 不能覆盖已有目标，先删除已备份的旧文件。
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 列出全部自定义素材，按角色分组：{ "yier": [...], "bubu": [...] }
#[tauri::command]
fn list_custom_assets(app: AppHandle) -> Result<Value, String> {
    let items = read_manifest(&app)?;
    let total = items.len();
    let mut yier: Vec<Value> = Vec::new();
    let mut bubu: Vec<Value> = Vec::new();
    let mut alive: Vec<CustomAsset> = Vec::with_capacity(total);
    for a in items {
        // 跳过磁盘上已丢失的文件
        if !Path::new(&a.path).exists() {
            continue;
        }
        // 用引用构造，避免提前移动 a 的字段（循环末尾还要把 a 收回 alive）
        let entry = serde_json::json!({
            "id": &a.id,
            "path": &a.path,
            "category": &a.category,
            "character": &a.character,
        });
        match a.character.as_str() {
            "yier" => yier.push(entry),
            "bubu" => bubu.push(entry),
            _ => {}
        }
        alive.push(a);
    }
    // 自愈：把指向已丢失文件的条目从 manifest 摘掉，避免其永久残留（写失败不影响本次返回）
    if alive.len() < total {
        if let Err(e) = write_manifest(&app, &alive) {
            eprintln!("manifest 自愈写入失败: {e}");
        }
    }
    Ok(serde_json::json!({ "yier": yier, "bubu": bubu }))
}

/// 新增自定义素材：校验格式 → 拷贝到角色目录 → 登记 manifest
#[tauri::command]
fn add_custom_asset(
    app: AppHandle,
    character: String,
    category: String,
    src_path: String,
) -> Result<Value, String> {
    if character != "yier" && character != "bubu" {
        return Err(format!("未知角色: {}", character));
    }
    if category != "idle" && category != "drag" {
        return Err(format!("未知分类: {}", category));
    }
    let src = PathBuf::from(&src_path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return Err(format!("不支持的格式: .{}", ext));
    }
    let dir = assets_dir(&app)?.join(&character);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let id = now_id();
    let dest = dir.join(format!("{}.{}", id, ext));
    fs::copy(&src, &dest).map_err(|e| format!("拷贝失败: {}", e))?;

    let asset = CustomAsset {
        id,
        character,
        category,
        path: dest.to_string_lossy().to_string(),
    };
    let mut items = read_manifest(&app)?;
    items.push(asset.clone());
    write_manifest(&app, &items)?;

    Ok(serde_json::json!({
        "id": asset.id,
        "path": asset.path,
        "category": asset.category,
        "character": asset.character,
    }))
}

/// 删除自定义素材（磁盘文件 + manifest 记录）
#[tauri::command]
fn remove_custom_asset(app: AppHandle, id: String) -> Result<(), String> {
    let mut items = read_manifest(&app)?;
    if let Some(pos) = items.iter().position(|a| a.id == id) {
        let removed = items.remove(pos);
        let _ = fs::remove_file(&removed.path); // 文件可能已不存在，忽略
        write_manifest(&app, &items)?;
    }
    Ok(())
}

// ── 开机自启：写入 Windows 注册表 HKCU\...\Run（零依赖，通过 reg.exe）──
#[cfg(windows)]
mod autostart_impl {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "oneno-pet";
    // CREATE_NO_WINDOW：调用 reg.exe 时不闪现控制台窗口
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Run 项是否已存在（reg query 命中返回退出码 0）
    pub fn is_enabled() -> Result<bool, String> {
        let out = Command::new("reg")
            .args(["query", RUN_KEY, "/v", VALUE_NAME])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("查询注册表失败: {e}"))?;
        Ok(out.status.success())
    }

    /// 开启：写入当前程序路径（带引号，兼容含空格路径）；关闭：删除该项
    pub fn set(enabled: bool) -> Result<(), String> {
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let exe = exe.to_str().ok_or("程序路径含非法字符")?;
            let data = format!("\"{exe}\"");
            let ok = Command::new("reg")
                .args([
                    "add",
                    RUN_KEY,
                    "/v",
                    VALUE_NAME,
                    "/t",
                    "REG_SZ",
                    "/d",
                    data.as_str(),
                    "/f",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map_err(|e| format!("写入注册表失败: {e}"))?
                .success();
            if !ok {
                return Err("写入注册表失败".into());
            }
        } else {
            // 值不存在时 reg 返回非 0，视作“已关闭”，忽略错误
            Command::new("reg")
                .args(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("删除注册表项失败: {e}"))?;
        }
        Ok(())
    }
}

/// 查询开机自启是否开启（仅 Windows；其它平台恒为 false）
#[tauri::command]
fn get_autostart() -> Result<bool, String> {
    #[cfg(windows)]
    {
        autostart_impl::is_enabled()
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// 开启 / 关闭开机自启（仅 Windows）
#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        autostart_impl::set(enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("开机自启仅支持 Windows".into())
    }
}

/// 显示指定窗口（取消最小化并聚焦）
fn show_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 切换桌宠主窗口的显示 / 隐藏
fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(true) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

/// 创建系统托盘图标：
/// - 左键点击 → 切换桌宠显隐
/// - 右键菜单 → 显示/隐藏、退出（桌宠隐藏后仍可通过它操作）
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle_i = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle_i, &sep, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("oneno 桌宠")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });

    // 复用应用内嵌图标作为托盘图标
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// 把窗口提到「置顶组」的最前面（不移动、不缩放、不抢焦点）。
///
/// 为什么需要它：桌宠的多个窗口都是 alwaysOnTop，它们彼此的层级由 Windows 置顶组的顺序决定。
/// tauri 的 `set_always_on_top` 内部走 `apply_diff`，**标志位没变化时直接 return**，
/// 所以「已经置顶了再调一次 setAlwaysOnTop(true)」是空操作，并不能把窗口提到同组其它窗口之上。
/// 可靠做法是直接 `SetWindowPos(HWND_TOPMOST)`：重复调用会把窗口重新排到置顶组首位。
///
/// 用途：① 倒计时面板翻到人物上方时，必须保证气泡（会话框）压在它上面 —— 手动关闭模式的气泡
/// 带确认按钮，被盖住就没法点了；② 重复启动程序时，把已有桌宠提到最前。
#[cfg(windows)]
mod topmost {
    // 直接声明 Win32 FFI，不为此引入 windows crate 依赖（否则版本还要跟 tauri 内部对齐）
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: *mut core::ffi::c_void,
            insert_after: *mut core::ffi::c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    /// HWND_TOPMOST 是 (HWND)-1 这个哨兵值
    const HWND_TOPMOST: isize = -1;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    // 调用方可能在 tauri 的线程池里，窗口属于主线程；用异步窗口位置避免跨线程同步等待
    const SWP_ASYNCWINDOWPOS: u32 = 0x4000;

    pub fn raise(win: &tauri::WebviewWindow) -> Result<(), String> {
        let hwnd = win.hwnd().map_err(|e| e.to_string())?;
        unsafe {
            SetWindowPos(
                hwnd.0,
                HWND_TOPMOST as *mut core::ffi::c_void,
                0,
                0,
                0,
                0,
                SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
            );
        }
        Ok(())
    }
}

#[cfg(windows)]
#[tauri::command]
fn raise_window(app: AppHandle, label: String) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("窗口不存在: {label}"))?;
    topmost::raise(&win)
}

/// 非 Windows 平台空实现，保证 `generate_handler!` 在各平台都能编译
#[cfg(not(windows))]
#[tauri::command]
fn raise_window(_app: AppHandle, _label: String) -> Result<(), String> {
    Ok(())
}

/// 重复启动程序时的处理：不开第二个桌宠，而是把已有的那个显示出来并提到最前。
///
/// 由 `tauri-plugin-single-instance` 在**第一个实例**里回调（第二个进程此刻已自行退出）。
fn focus_existing_pet(app: &AppHandle) {
    show_window(app, "main");
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        if let Err(e) = topmost::raise(&w) {
            eprintln!("单实例：提升桌宠窗口层级失败: {e}");
        }
    }
}

/// 用系统默认浏览器打开 https 链接（更新失败时跳转 Release 下载页兜底）。
/// 零额外依赖：Windows 下走 `rundll32 url.dll,FileProtocolHandler`，与开机自启走 reg.exe 同理。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // 只放行 https，避免被当作参数注入到命令行
    if !url.starts_with("https://") {
        return Err("仅支持 https 链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("打开链接仅支持 Windows".into())
    }
}

/// 注册原生 F12 快捷键；不依赖前端页面加载成功
#[cfg(windows)]
async fn register_devtools_shortcut(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    };

    let state = app.state::<DevtoolsState>();
    // 启动和设置页可能同时调用，串行注册，避免一次按键触发多个回调。
    let mut registered = state.registered.lock().await;
    for window in app.webview_windows().values() {
        let label = window.label().to_owned();
        if registered.contains(&label) {
            continue;
        }
        let allowed = state.enabled.clone();
        let target = window.clone();
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        window
            .with_webview(move |webview| unsafe {
                let result = (|| -> Result<(), String> {
                    let controller = webview.controller();
                    let core = controller.CoreWebView2().map_err(|e| e.to_string())?;
                    // 禁用浏览器内置入口，由应用按开关状态主动打开，避免默认快捷键冲突。
                    core.Settings()
                        .and_then(|s| s.SetAreDevToolsEnabled(false))
                        .map_err(|e| e.to_string())?;
                    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut key = 0;
                        args.VirtualKey(&mut key)?;
                        // F12 的 Windows 虚拟键码。
                        if key != 0x7B {
                            return Ok(());
                        }
                        args.SetHandled(true)?;
                        let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                        args.KeyEventKind(&mut kind)?;
                        let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                        args.PhysicalKeyStatus(&mut status)?;
                        if (kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                            || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN)
                            && !status.WasKeyDown.as_bool()
                            && allowed.load(Ordering::SeqCst)
                        {
                            let target = target.clone();
                            let allowed = allowed.clone();
                            // 按键回调结束后再打开窗口，避免 WebView2 同步回调中的重入。
                            tauri::async_runtime::spawn(async move {
                                if allowed.load(Ordering::SeqCst) {
                                    target.open_devtools();
                                }
                            });
                        }
                        Ok(())
                    }));
                    let mut token = 0;
                    controller
                        .add_AcceleratorKeyPressed(&handler, &mut token)
                        .map_err(|e| e.to_string())?;
                    Ok(())
                })();
                let _ = sender.try_send(result);
            })
            .map_err(|e| e.to_string())?;
        // 等待原生回调的真实结果，不能只以消息投递成功作为设置成功。
        receiver
            .recv()
            .await
            .ok_or_else(|| format!("窗口 {label} 未完成 F12 注册"))??;
        registered.insert(label);
    }
    Ok(())
}

/// 注册成功后更新所有窗口共用的权限
#[cfg(windows)]
#[tauri::command]
async fn set_devtools_allowed(app: AppHandle, enabled: bool) -> Result<(), String> {
    register_devtools_shortcut(&app).await?;
    app.state::<DevtoolsState>()
        .enabled
        .store(enabled, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// 非 Windows 平台空实现，保证命令在各平台都能注册
#[cfg(not(windows))]
#[tauri::command]
fn set_devtools_allowed(_app: AppHandle, _enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 必须**第一个**注册：它要在其它插件初始化之前就判定「已有实例在跑」，
        // 是则把参数转交过去、让本次进程立刻退出，从而保证桌宠唯一。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_existing_pet(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        // 应用内更新：endpoints / pubkey 见 tauri.conf.json 的 plugins.updater。
        // 不注册 process 插件：Windows 上插件启动安装程序后即 exit(0)，由 NSIS 重启应用，
        // 前端没有（也不需要）relaunch 可调。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(windows)]
            {
                // 在原生启动阶段恢复权限，避免前端尚未加载或报错时 F12 无效。
                let enabled = load_config(app.handle().clone())
                    .unwrap_or_else(|error| {
                        eprintln!("读取开发者工具配置失败: {error}");
                        None
                    })
                    .and_then(|config| config["allowDevTools"].as_bool())
                    .unwrap_or(false);
                app.manage(DevtoolsState {
                    enabled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(enabled)),
                    ..Default::default()
                });
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = register_devtools_shortcut(&handle).await {
                        eprintln!("注册 F12 快捷键失败: {error}");
                    }
                });
            }
            build_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            quit,
            load_config,
            save_config,
            list_custom_assets,
            add_custom_asset,
            remove_custom_asset,
            get_autostart,
            set_autostart,
            set_devtools_allowed,
            raise_window,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running oneno-pet");
}
