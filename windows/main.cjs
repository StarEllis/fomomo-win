const { app, BrowserWindow, clipboard, ipcMain, screen, Tray, Menu, nativeImage, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createAlerter } = require("./alerts.cjs");

const APP_NAME = "fomomo";
const APP_ICON = path.join(__dirname, "assets", "icon.ico");
const GMGN_HOME = "https://gmgn.ai/?chain=robinhood";
const GMGN_FALLBACK_QUERY = "device_id=&client_id=gmgn_web&from_app=gmgn&app_ver=&tz_name=Asia%2FShanghai&tz_offset=28800&app_lang=zh-CN&os=web";
const ALLOWED_COMMANDS = new Set([
  "focus", "front_rank_visible", "kline", "context",
  "fomo_thesis_more", "gmgn_calls_more", "simulate",
]);

let quitting = false;
let overlayWindow = null;
let detailWindow = null;
let dashboardWindow = null;
let gmgnWindow = null;
let fomoWindow = null;
let tray = null;
let sidecar = null;
let sidecarBuffer = "";
let sidecarGeneration = 0;
let restartTimer = null;
let restartBackoffMs = 1000;
let dashboardUrl = null;
let pendingDashboardTab = null;
let onboardingShown = false;
let compact = false;
let expandedBounds = null;
let savePanelTimer = null;
const alerter = createAlerter();
let selectedAddress = null;
let selectedChain = null;
// 新币自动弹出的卡（不抢焦点、按设置停留几秒后自动收起）；用户在卡上按下鼠标即钉住转为手动卡
let detailAuto = false;
let detailDismissTimer = null;
// 悬浮窗「fomo 前排」兴趣集：渲染层上报可见行，面板隐藏 / 收起时对 sidecar 发 []，恢复或 sidecar 重启后重放
let frontRankVisible = [];
let frontRankSent = null;
let resizeStart = null;
let tokenState = [];
let currentStatus = { state: "starting", detail: "正在启动群监听…" };
const cachedEvents = new Map();

let gmgnState = "idle";
let gmgnMessage = "";
let gmgnReloadAt = 0;
let fomoToken = null;
let fomoMe = null;
let fomoReloadAt = 0;
const fomoResponses = new Map();
// 悬浮窗隐藏 / 收起期间到的新币：计数挂在托盘提示和收起态角标上，托盘气泡点开最近一个
let unseenCount = 0;
// 托盘气泡被点时做什么（新币 → 打开详情；gmgn 验证 → 打开 gmgn 窗口）
let balloonAction = null;
let gmgnNotifiedAt = 0;
// 设置里记住的位置 / 收起态只在第一次拿到设置时恢复，之后的设置推送（多半是自己刚存的）不再挪窗口
let panelRestored = false;
let saveMoveTimer = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showOverlay(true));
}

// 日志落盘到数据目录旁（与 sidecar 的 DATA_DIR 同一个 %LOCALAPPDATA%\Fomomo），用户出问题时可以直接把文件发过来。
// 启动时超过 10MB 就轮换成 .old.log，只保留一份旧的
const LOG_DIR = path.join(process.env.FOMOMO_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "Fomomo"), "logs");
const LOG_FILE = path.join(LOG_DIR, "fomomo.log");
let logStream = null;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 10 * 1024 * 1024) fs.renameSync(LOG_FILE, path.join(LOG_DIR, "fomomo.old.log"));
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  logStream.on("error", () => { logStream = null; });
} catch {
  logStream = null;
}

function log(scope, message) {
  const line = `[${scope}] ${String(message).replace(/[\r\n]+/g, " ").slice(0, 800)}`;
  console.log(line);
  logStream?.write(`${new Date().toISOString()} ${line}\n`);
}

// monitor 版只记录，不改变 Electron 默认的崩溃处理
process.on("uncaughtExceptionMonitor", (error) => log("main", `uncaught: ${error?.stack || error}`));

function rendererPath(name) {
  return path.join(__dirname, name);
}

function webPreferences() {
  return {
    preload: rendererPath("preload.cjs"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  };
}

function makeSafeLocalWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://") || url.startsWith("http://127.0.0.1:")) return;
    event.preventDefault();
    openExternal(url);
  });
}

function createOverlayWindow() {
  const work = screen.getPrimaryDisplay().workArea;
  const settings = cachedEvents.get("settings")?.settings?.panel;
  const width = Math.max(PANEL_MIN.width, Math.min(PANEL_MAX_WIDTH, Number(settings?.width) || 366));
  const height = Math.max(PANEL_MIN.height, Math.min(work.height - 28, Number(settings?.height) || 720));
  // 透明窗口：dashboard 的「背景不透明度」只作用于底色，文字保持不透明（同 macOS GlassBackground）。
  // Windows 上透明窗口不能用系统边框缩放，改由渲染层的边缘手柄经 IPC 调整尺寸（见 resizePanel）
  overlayWindow = new BrowserWindow({
    title: APP_NAME,
    width,
    height,
    x: work.x + 12,
    y: work.y + 14,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: webPreferences(),
  });
  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.loadFile(rendererPath("overlay.html"));
  makeSafeLocalWindow(overlayWindow);
  overlayWindow.once("ready-to-show", () => overlayWindow?.showInactive());
  overlayWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    hideDetail();
    overlayWindow?.hide();
    rebuildTrayMenu();
  });
  overlayWindow.on("show", () => { rebuildTrayMenu(); pushFrontRankVisible(); if (!compact) setUnseen(0); });
  overlayWindow.on("hide", () => { rebuildTrayMenu(); pushFrontRankVisible(); });
  // 拖动结束（Windows 上只有用户拖动才触发）：记住位置，收起态也记（收起窗的左上角就是展开时的左上角）
  overlayWindow.on("moved", () => {
    clearTimeout(saveMoveTimer);
    saveMoveTimer = setTimeout(() => {
      if (!overlayWindow) return;
      const { x, y } = overlayWindow.getBounds();
      void savePanel({ x, y });
    }, 400);
  });
}

/** 把窗口挪回它最靠近的那块屏幕的工作区里（拔掉副屏后记住的坐标可能在屏幕外） */
function fitOnScreen(b) {
  const work = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width, work.width), height = Math.min(b.height, work.height);
  return {
    x: Math.round(Math.min(Math.max(b.x, work.x), work.x + work.width - width)),
    y: Math.round(Math.min(Math.max(b.y, work.y), work.y + work.height - height)),
    width,
    height,
  };
}

const PANEL_MIN = { width: 320, height: 420 };
const PANEL_MAX_WIDTH = 600;

/**
 * 渲染层边缘手柄拖动：start 记下起始边界，move 按屏幕位移（DIP）改尺寸，end 保存到设置。上边拖动改高度并保持下边不动。
 * edge = "move" 是收起小图标的拖动（整块都是展开按钮，不能用系统拖动区，否则点击会被吞掉）：只挪位置，松手后夹回屏幕并保存
 */
function resizePanel({ phase, edge, dx, dy } = {}) {
  const moving = edge === "move";
  if (!overlayWindow || compact !== moving) return;
  if (phase === "start") { resizeStart = overlayWindow.getBounds(); return; }
  if (!resizeStart) return;
  if (moving) {
    if (phase === "end") {
      resizeStart = null;
      const b = fitOnScreen(overlayWindow.getBounds());
      overlayWindow.setBounds(b);
      void savePanel({ x: b.x, y: b.y });
      return;
    }
    overlayWindow.setBounds({ ...resizeStart, x: Math.round(resizeStart.x + (Number(dx) || 0)), y: Math.round(resizeStart.y + (Number(dy) || 0)) });
    return;
  }
  if (phase === "end") {
    resizeStart = null;
    clearTimeout(savePanelTimer);
    savePanelTimer = setTimeout(savePanelBounds, 200);
    return;
  }
  const b = { ...resizeStart };
  const work = screen.getDisplayMatching(b).workArea;
  const maxH = work.height;
  const ddx = Number(dx) || 0, ddy = Number(dy) || 0;
  if (String(edge).includes("right")) b.width = Math.round(Math.max(PANEL_MIN.width, Math.min(PANEL_MAX_WIDTH, resizeStart.width + ddx)));
  if (String(edge).includes("bottom")) b.height = Math.round(Math.max(PANEL_MIN.height, Math.min(maxH, resizeStart.height + ddy)));
  if (String(edge).includes("top")) {
    const h = Math.round(Math.max(PANEL_MIN.height, Math.min(maxH, resizeStart.height - ddy)));
    b.y = resizeStart.y + resizeStart.height - h;
    b.height = h;
  }
  overlayWindow.setBounds(b);
}

/** 按面板状态把兴趣集发给 sidecar（隐藏 / 收起 → []）；内容没变不重发 */
function pushFrontRankVisible(force = false) {
  const list = overlayWindow?.isVisible() && !compact ? frontRankVisible : [];
  const key = list.join(",");
  if (!force && key === frontRankSent) return;
  if (sendSidecar({ t: "front_rank_visible", addresses: list })) frontRankSent = key;
}

function createDetailWindow() {
  detailWindow = new BrowserWindow({
    title: "fomomo · 代币详情",
    width: 1220,
    height: 780,
    minWidth: 860,
    minHeight: 580,
    frame: false,
    transparent: false,
    backgroundColor: "#111518",
    show: false,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: webPreferences(),
  });
  detailWindow.setAlwaysOnTop(true, "floating");
  detailWindow.loadFile(rendererPath("detail.html"));
  makeSafeLocalWindow(detailWindow);
  detailWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    hideDetail();
  });
}

function positionDetail() {
  if (!overlayWindow || !detailWindow) return;
  const anchor = overlayWindow.getBounds();
  const work = screen.getDisplayMatching(anchor).workArea;
  const gap = 10;
  const availableRight = work.x + work.width - (anchor.x + anchor.width) - gap;
  // ≥1460 时详情页把 GMGN 喊单 / fomo Thesis 两列并排在右栏旁（detail.html 的宽屏布局）
  const width = Math.max(860, Math.min(1560, availableRight >= 860 ? availableRight : work.width - 24));
  const height = Math.max(580, Math.min(work.height - 24, 840));
  let x = anchor.x + anchor.width + gap;
  if (availableRight < 860) x = work.x + Math.round((work.width - width) / 2);
  const y = Math.max(work.y + 12, Math.min(anchor.y, work.y + work.height - height - 12));
  detailWindow.setBounds({ x, y, width, height });
}

function showOverlay(focus = false) {
  if (!overlayWindow) return;
  overlayWindow.show();
  if (focus) overlayWindow.focus();
  else overlayWindow.showInactive();
  rebuildTrayMenu();
}

/**
 * 打开详情卡。auto = 新币自动弹出：不抢焦点、6s 后自动收起；用户正在看的手动卡不会被自动卡顶掉。
 * 手动打开（点行）同样用 showInactive，焦点留在悬浮窗 / 用户原来的窗口，点卡片时再由系统给焦点。
 */
function showDetail(input, auto = false) {
  const token = resolveToken(input);
  if (!token || !detailWindow) return;
  if (auto && detailWindow.isVisible() && !detailAuto) return;
  clearTimeout(detailDismissTimer);
  detailAuto = auto;
  selectedAddress = token.address;
  selectedChain = token.market?.chain || token.chainHint || null;
  positionDetail();
  detailWindow.showInactive();
  detailWindow.webContents.send("fomomo:event", { t: "detail_selected", token, auto });
  sendSidecar({ t: "focus", address: selectedAddress, chain: selectedChain });
  if (auto) detailDismissTimer = setTimeout(hideDetail, popupSettings().seconds * 1000);
}

/** 用户在卡上按下了鼠标：取消自动收起，之后的新币也不再顶掉它 */
function pinDetail() {
  if (!detailAuto) return;
  clearTimeout(detailDismissTimer);
  detailAuto = false;
  detailWindow?.webContents.send("fomomo:event", { t: "detail_pinned" });
}

function hideDetail() {
  clearTimeout(detailDismissTimer);
  detailAuto = false;
  if (detailWindow?.isVisible()) detailWindow.hide();
  if (selectedAddress) sendSidecar({ t: "focus", address: null, chain: null });
  selectedAddress = null;
  selectedChain = null;
}

function resolveToken(input) {
  const address = typeof input === "string" ? input : input?.address;
  const chain = typeof input === "object" ? (input?.market?.chain || input?.chainHint || null) : null;
  return tokenState.find((t) => t.address === address && (!chain || (t.market?.chain || t.chainHint) === chain))
    || (typeof input === "object" && input?.address ? input : null);
}

/** dashboard「设置」里的新币弹卡方式；设置还没到时按默认（弹卡、6 秒） */
function popupSettings() {
  const p = cachedEvents.get("settings")?.settings?.popup;
  return {
    mode: ["card", "notify", "off"].includes(p?.mode) ? p.mode : "card",
    seconds: Math.max(2, Math.min(60, Number(p?.seconds) || 6)),
  };
}

async function putSettings(patch) {
  if (!dashboardUrl) throw new Error("数据进程还没就绪");
  const res = await fetch(new URL("/api/settings", dashboardUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function savePanel(patch) {
  if (!dashboardUrl) return;
  try {
    await putSettings({ panel: patch });
  } catch (error) {
    log("panel", `悬浮窗设置保存失败: ${error.message}`);
  }
}

/** 悬浮窗行的右键菜单（原生菜单）：详情 / 复制地址 / 外链 / 不再显示 */
function showRowMenu(input) {
  const token = resolveToken(input);
  if (!token || !overlayWindow) return;
  const chain = token.market?.chain || token.chainHint || null;
  const symbol = token.market?.symbol || `${token.address.slice(0, 6)}…${token.address.slice(-4)}`;
  Menu.buildFromTemplate([
    { label: `查看 ${symbol} 详情`, click: () => showDetail(token) },
    { label: "复制合约地址", click: () => clipboard.writeText(token.address) },
    { type: "separator" },
    { label: chain ? "在 GMGN 打开" : "在 GMGN 打开（链还没识别出来）", enabled: !!chain, click: () => openExternal(`https://gmgn.ai/${encodeURIComponent(chain)}/token/${encodeURIComponent(token.address)}`) },
    { label: "在 DexScreener 搜索", click: () => openExternal(`https://dexscreener.com/search?q=${encodeURIComponent(token.address)}`) },
    { type: "separator" },
    { label: "不再显示此币", click: () => void setTokenMuted(token.address, true, symbol) },
  ]).popup({ window: overlayWindow });
}

/** 隐藏 / 取消隐藏一个代币：改 settings.mutedTokens，sidecar 据此从列表里拿掉（喊单记录保留） */
async function setTokenMuted(address, muted, symbol = "") {
  const current = cachedEvents.get("settings")?.settings?.mutedTokens || [];
  const next = muted ? [...current.filter((a) => a !== address), address] : current.filter((a) => a !== address);
  try {
    await putSettings({ mutedTokens: next });
    if (muted) overlayWindow?.webContents.send("fomomo:event", { t: "token_muted", address, symbol });
  } catch (error) {
    log("mute", `${muted ? "隐藏" : "恢复"}代币失败: ${error.message}`);
    overlayWindow?.webContents.send("fomomo:event", { t: "toast", text: `操作失败：${error.message}` });
  }
}

function savePanelBounds() {
  if (!overlayWindow || compact) return;
  const { width, height, x, y } = overlayWindow.getBounds();
  void savePanel({ width, height, x, y });
}

function applyPanelSettings(event) {
  const panel = event?.settings?.panel;
  if (!panel || !overlayWindow) return;
  if (!panelRestored) {
    // 启动后第一次拿到设置：恢复尺寸、位置、收起态
    panelRestored = true;
    const bounds = overlayWindow.getBounds();
    const width = Math.max(PANEL_MIN.width, Math.min(PANEL_MAX_WIDTH, Number(panel.width) || bounds.width));
    const height = Math.max(PANEL_MIN.height, Number(panel.height) || bounds.height);
    const hasPos = Number.isFinite(panel.x) && Number.isFinite(panel.y);
    overlayWindow.setBounds(fitOnScreen({ x: hasPos ? panel.x : bounds.x, y: hasPos ? panel.y : bounds.y, width, height }));
    if (panel.compact) {
      toggleCompact(true);
      overlayWindow.webContents.send("fomomo:event", { t: "compact", value: true });
    }
    return;
  }
  if (compact) return;
  const bounds = overlayWindow.getBounds();
  const display = screen.getDisplayMatching(bounds).workArea;
  const width = Math.max(PANEL_MIN.width, Math.min(PANEL_MAX_WIDTH, Number(panel.width) || bounds.width));
  const height = Math.max(PANEL_MIN.height, Math.min(display.height, Number(panel.height) || bounds.height));
  if (resizeStart || (width === bounds.width && height === bounds.height)) return;
  overlayWindow.setBounds({ ...bounds, width, height });
}

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    title: "fomomo · 设置与统计",
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#111416",
    autoHideMenuBar: true,
    webPreferences: { preload: rendererPath("dashboard-preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  dashboardWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!openTokenLink(url)) openExternal(url);
    return { action: "deny" };
  });
  // 加载失败（sidecar 正在重启）时清掉标记，下次打开重新加载
  dashboardWindow.webContents.on("did-fail-load", (_event, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && dashboardWindow) dashboardWindow.fomomoOrigin = null;
  });
  dashboardWindow.on("closed", () => { dashboardWindow = null; });
}

function showDashboard(tab = null) {
  if (!dashboardUrl) {
    pendingDashboardTab = tab || pendingDashboardTab || "groups";
    return;
  }
  // 已打开同一个 dashboard 时只切页签，不整页重载：群组页没保存的勾选、各页筛选都留着。
  // sidecar 重启后端口会变，这时才重新加载
  if (dashboardWindow && dashboardWindow.fomomoOrigin === dashboardUrl) {
    if (tab) dashboardWindow.webContents.executeJavaScript(`window.showTab(${JSON.stringify(tab)})`, true).catch((error) => log("dashboard", `switch tab failed: ${error.message}`));
  } else {
    if (!dashboardWindow) createDashboardWindow();
    const url = new URL(dashboardUrl);
    url.searchParams.set("native", "1");
    url.searchParams.set("platform", "win32");
    if (tab) url.hash = tab;
    dashboardWindow.fomomoOrigin = dashboardUrl;
    dashboardWindow.loadURL(url.toString());
  }
  if (dashboardWindow.isMinimized()) dashboardWindow.restore();
  dashboardWindow.show();
  dashboardWindow.focus();
}

/**
 * dashboard 里的代币链接都是 gmgn.ai/<链>/token/<地址>：改为打开详情卡（同悬浮窗点行）。
 * 追踪列表里有的按地址 + 链找（链对不上时按地址），没有的按链建临时持仓，sidecar 以 token_detail 推回数据
 */
function openTokenLink(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  const m = url.hostname === "gmgn.ai" && url.pathname.match(/^\/([a-z0-9]+)\/token\/([0-9A-Za-z]{32,44})$/);
  if (!m) return false;
  const [, chain, address] = m;
  const token = tokenState.find((t) => t.address === address && (t.market?.chain || t.chainHint) === chain)
    || tokenState.find((t) => t.address === address)
    || { address, chainHint: chain };
  showDetail(token);
  return true;
}

function openExternal(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") void shell.openExternal(url.toString());
  } catch {
    // Ignore malformed renderer-provided values.
  }
}

function sidecarSpec() {
  if (app.isPackaged) {
    return {
      node: path.join(process.resourcesPath, "node", "node.exe"),
      cwd: path.join(process.resourcesPath, "sidecar"),
      args: ["cli.mjs", "run"],
      lark: path.join(process.resourcesPath, "bin", "lark-cli.exe"),
    };
  }
  const root = path.resolve(__dirname, "..");
  return {
    node: process.env.FOMOMO_NODE || "node.exe",
    cwd: root,
    args: ["--import", "tsx", path.join(root, "src", "cli.ts"), "run"],
    lark: process.env.FOMOMO_LARK_CLI || null,
  };
}

function startSidecar() {
  if (quitting || sidecar) return;
  const spec = sidecarSpec();
  if (app.isPackaged && (!fs.existsSync(spec.node) || !fs.existsSync(path.join(spec.cwd, "cli.mjs")))) {
    setStatus("failed", "安装包缺少 Windows sidecar 运行文件");
    return;
  }
  const generation = ++sidecarGeneration;
  const env = { ...process.env, FOMOMO_WINDOWS_FEISHU: "1", NO_COLOR: "1" };
  env.FOMOMO_WECHAT_KEY_DLL = app.isPackaged
    ? path.join(process.resourcesPath, "wechat-key", "wechat_key_tool.dll")
    : path.join(path.resolve(__dirname, ".."), "resources", "wechat_key_tool.dll");
  if (app.isPackaged) env.NODE_PATH = path.join(spec.cwd, "vendor");
  if (spec.lark && fs.existsSync(spec.lark)) env.FOMOMO_LARK_CLI = spec.lark;
  // 双击启动时 Windows 传过来的键名是 Path 不是 PATH，而展开成普通对象后读写就不再大小写不敏感了：
  // 写死 env.PATH 会多出一个只剩 node 目录的第二个 PATH，子进程里 System32 可能就没了（spawn 找不到 powershell.exe）
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  if (path.isAbsolute(spec.node)) env[pathKey] = `${path.dirname(spec.node)}${path.delimiter}${env[pathKey] || ""}`;
  setStatus(sidecarGeneration === 1 ? "starting" : "restarting", sidecarGeneration === 1 ? "正在启动群监听…" : "数据进程正在重连…");
  sidecarBuffer = "";
  try {
    sidecar = spawn(spec.node, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    sidecar = null;
    setStatus("failed", `无法启动数据进程: ${error.message}`);
    return scheduleSidecarRestart();
  }
  log("sidecar", `started pid=${sidecar.pid || "?"} mode=${app.isPackaged ? "bundled" : "dev"}`);
  sidecar.stdout.setEncoding("utf8");
  sidecar.stdout.on("data", (chunk) => consumeSidecar(chunk, generation));
  sidecar.stderr.setEncoding("utf8");
  sidecar.stderr.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim()) log("sidecar", line);
  });
  sidecar.once("error", (error) => {
    if (generation !== sidecarGeneration) return;
    setStatus("failed", `数据进程启动失败: ${error.message}`);
  });
  sidecar.once("close", (code, signal) => {
    if (generation !== sidecarGeneration) return;
    sidecar = null;
    if (quitting) return;
    setStatus("restarting", `数据进程已退出（${signal || (code ?? "?")}），正在重连…`);
    scheduleSidecarRestart();
  });
}

function scheduleSidecarRestart() {
  if (quitting || restartTimer) return;
  const delay = restartBackoffMs;
  restartBackoffMs = Math.min(restartBackoffMs * 2, 30_000);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startSidecar();
  }, delay);
}

function consumeSidecar(chunk, generation) {
  if (generation !== sidecarGeneration) return;
  sidecarBuffer += chunk;
  let newline;
  while ((newline = sidecarBuffer.indexOf("\n")) !== -1) {
    const line = sidecarBuffer.slice(0, newline).trim();
    sidecarBuffer = sidecarBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      handleSidecarEvent(JSON.parse(line));
    } catch (error) {
      log("sidecar", `bad JSON line (${line.length} chars): ${error.message}`);
    }
  }
}

function handleSidecarEvent(event) {
  if (!event || typeof event.t !== "string") return;
  if (event.t === "rpc") {
    void handleRpc(event);
    return;
  }
  if (event.t === "ready" || event.t === "heartbeat") {
    restartBackoffMs = 1000;
    setStatus("connected", event.t === "ready" ? groupStatus(event.groups) : currentStatus.detail);
  }
  if (event.t === "ready") {
    cachedEvents.set("ready", event);
    // 新 sidecar 进程没有旧兴趣集，也不知道当前焦点
    pushFrontRankVisible(true);
    if (selectedAddress) sendSidecar({ t: "focus", address: selectedAddress, chain: selectedChain });
  }
  if (event.t === "state" && Array.isArray(event.tokens)) {
    tokenState = event.tokens;
    cachedEvents.set("state", event);
    if (selectedAddress) {
      // 只跟列表里真有的币（同 Swift applyState.follow）：链未知时按地址跟，已知时地址 + 链都要对上
      const updated = tokenState.find((t) => t.address === selectedAddress && (!selectedChain || (t.market?.chain || t.chainHint) === selectedChain));
      if (updated) {
        // 卡打开时链未知（新币 ~0.5s 后行情才到）：链到了就跟上并重发 focus
        const chain = updated.market?.chain || updated.chainHint || null;
        if (chain !== selectedChain) { selectedChain = chain; sendSidecar({ t: "focus", address: selectedAddress, chain }); }
        detailWindow?.webContents.send("fomomo:event", { t: "detail_selected", token: updated, auto: detailAuto });
      }
    }
    const alerts = alerter.update(tokenState, cachedEvents.get("settings")?.settings?.popup);
    if (alerts.length) dispatchAlerts(alerts);
  } else if (event.t === "token_detail" && event.token?.address === selectedAddress) {
    // 不在追踪列表里的币（dashboard 点开的旧币）：数据不进 state，单独推给详情卡
    detailWindow?.webContents.send("fomomo:event", { t: "detail_selected", token: event.token, auto: detailAuto });
  } else if (event.t === "token_hidden" && event.address === selectedAddress) {
    hideDetail();
  } else if (event.t === "dashboard" && typeof event.url === "string") {
    dashboardUrl = event.url;
    cachedEvents.set("dashboard", event);
    if (pendingDashboardTab) {
      const tab = pendingDashboardTab;
      pendingDashboardTab = null;
      showDashboard(tab);
    }
  } else if (event.t === "sources") {
    cachedEvents.set("sources", event);
    if (!onboardingShown && (event.firstRun || event.configured === false)) {
      onboardingShown = true;
      showDashboard("groups");
    }
  } else if (event.t === "settings") {
    cachedEvents.set("settings", event);
    applyPanelSettings(event);
  } else if (["fomo_state", "trade_state", "trade_holdings", "source_health"].includes(event.t)) {
    cachedEvents.set(event.t, event);
  }
  broadcastEvent(event);
}

/**
 * 一次 state 里达到提醒条件的币（alerts.cjs）：悬浮窗在看 → 按设置弹卡 / 发系统提醒；
 * 看不到 → 计未读，除「不提醒」外发托盘气泡。一次多个只弹最后一个，气泡标题带总数
 */
function dispatchAlerts(alerts) {
  for (const a of alerts) {
    if (a.kind === "heat") overlayWindow?.webContents.send("fomomo:event", { t: "token_heat", address: a.token.address, recent: a.recent });
  }
  const { mode } = popupSettings();
  const last = alerts[alerts.length - 1];
  if (overlayWindow?.isVisible() && !compact) {
    if (mode === "card") showDetail(last.token, true);
    else if (mode === "notify") notifyAlert(last, alerts.length);
    return;
  }
  setUnseen(unseenCount + alerts.length);
  if (mode !== "off") notifyAlert(last, alerts.length);
}

/** 托盘气泡（Windows 10+ 显示为系统通知，不依赖开始菜单快捷方式）；点气泡 = 展开悬浮窗并打开这个币的详情卡 */
function notifyAlert({ kind, token, recent }, total = 1) {
  const m = token.market || {};
  const chain = String(m.chain || token.chainHint || "").toUpperCase();
  const name = m.symbol || `${token.address.slice(0, 6)}…${token.address.slice(-4)}`;
  const more = total > 1 ? `（共 ${total} 个）` : "";
  const mentions = token.mentions || [];
  let title, content;
  if (kind === "heat") {
    const last = mentions[mentions.length - 1];
    title = `🔥 再次被喊 · ${name}${more}`;
    content = [chain, `30 分钟内 ${recent} 人喊，累计 ${token.kol || 0} 人`, last?.sender ? `${last.sender}：${String(last.text || "").slice(0, 50)}` : null].filter(Boolean).join(" · ");
  } else {
    const first = mentions[0];
    title = `新喊单 · ${name}${more}`;
    content = [chain, (token.kol || 0) > 1 ? `${token.kol} 人喊` : first?.sender ? `${first.sender} 喊` : null, first?.text ? String(first.text).slice(0, 60) : null].filter(Boolean).join(" · ");
  }
  showBalloon(title, content || token.address, () => openNotifiedToken(token));
}

function showBalloon(title, content, onClick) {
  balloonAction = onClick;
  try {
    tray?.displayBalloon({ iconType: "custom", icon: nativeImage.createFromPath(APP_ICON), title, content, noSound: false });
  } catch (error) {
    log("notify", `balloon failed: ${error.message}`);
  }
}

function setUnseen(n) {
  unseenCount = n;
  tray?.setToolTip(n > 0 ? `fomomo · ${n} 个新喊单未看` : "fomomo · 群喊单监听");
  overlayWindow?.webContents.send("fomomo:event", { t: "unseen", count: n });
}

function openNotifiedToken(token) {
  if (compact) {
    toggleCompact(false);
    overlayWindow?.webContents.send("fomomo:event", { t: "compact", value: false });
  }
  showOverlay(true);
  showDetail(token);
}

function groupStatus(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return "还没选择要监听的群";
  const first = groups[0]?.displayName || "群";
  return groups.length === 1 ? `正在监听 ${first}` : `正在监听 ${first} 等 ${groups.length} 个群`;
}

function sendSidecar(event) {
  if (!event || typeof event.t !== "string" || !sidecar?.stdin?.writable) return false;
  try {
    sidecar.stdin.write(`${JSON.stringify(event)}\n`);
    return true;
  } catch (error) {
    log("sidecar", `stdin write failed: ${error.message}`);
    return false;
  }
}

function setStatus(state, detail) {
  currentStatus = { state, detail: detail || "" };
  for (const win of [overlayWindow, detailWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("fomomo:status", currentStatus);
  }
  rebuildTrayMenu();
}

function broadcastEvent(event) {
  for (const win of [overlayWindow, detailWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("fomomo:event", event);
  }
}

function bootstrap() {
  return {
    status: currentStatus,
    events: Object.fromEntries(cachedEvents),
    tokens: tokenState,
    selected: selectedAddress ? resolveToken({ address: selectedAddress, chainHint: selectedChain }) : null,
    selectedAuto: detailAuto,
    gmgn: { state: gmgnState, message: gmgnMessage },
    platform: "win32",
    capabilities: { feishu: true, wechat: true, qq: true, trade: false },
    compact,
  };
}

function createTray() {
  // nativeImage 不认 SVG；icon.ico 由 scripts/make-windows-icons.cjs 从 tray.svg 生成，含 16–256 各尺寸，系统按 DPI 取
  tray = new Tray(nativeImage.createFromPath(APP_ICON));
  tray.setToolTip("fomomo · 群喊单监听");
  // 双击 = 打开 dashboard 总览。Windows 双击前会先发一次 click，所以单击延迟到双击判定窗口之后再切悬浮窗
  let clickTimer = null;
  tray.on("click", () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => overlayWindow?.isVisible() ? overlayWindow.hide() : showOverlay(true), 250);
  });
  tray.on("double-click", () => {
    clearTimeout(clickTimer);
    showDashboard("overview");
  });
  tray.on("balloon-click", () => balloonAction?.());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const visible = !!overlayWindow?.isVisible();
  const onTop = overlayWindow?.isAlwaysOnTop() ?? true;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: currentStatus.detail || "群监听", enabled: false },
    { type: "separator" },
    { label: visible ? "隐藏悬浮窗" : "显示悬浮窗", click: () => visible ? overlayWindow?.hide() : showOverlay(true) },
    { label: "打开群组设置", click: () => showDashboard("groups") },
    { label: "打开统计面板", click: () => showDashboard("overview") },
    { label: "登录 fomo.family（可选）", click: showFomoLogin },
    { label: "处理 GMGN 验证", click: showGmgnWindow },
    { type: "separator" },
    { label: "始终置顶", type: "checkbox", checked: onTop, click: (item) => setWindowsAlwaysOnTop(item.checked) },
    { label: "退出 fomomo", click: () => { quitting = true; app.quit(); } },
  ]));
}

function setWindowsAlwaysOnTop(value) {
  overlayWindow?.setAlwaysOnTop(value, "floating");
  detailWindow?.setAlwaysOnTop(value, "floating");
  overlayWindow?.webContents.send("fomomo:event", { t: "always_on_top", value });
  rebuildTrayMenu();
}

function toggleCompact(next) {
  if (!overlayWindow || compact === next) return;
  if (next) {
    expandedBounds = overlayWindow.getBounds();
    compact = true;
    hideDetail();
    overlayWindow.setBounds({ x: expandedBounds.x, y: expandedBounds.y, width: 72, height: 72 });
  } else {
    compact = false;
    // 收起时可能被拖到了别处：从收起窗现在的左上角展开，并保证整块落在屏幕里
    const at = overlayWindow.getBounds();
    const size = expandedBounds || { width: 366, height: 720 };
    overlayWindow.setBounds(fitOnScreen({ x: at.x, y: at.y, width: size.width, height: size.height }));
    if (overlayWindow.isVisible()) setUnseen(0);
  }
  pushFrontRankVisible();
  const { x, y } = overlayWindow.getBounds();
  void savePanel({ compact: next, x, y });
}

/** 亮出内置 gmgn 窗口做 Cloudflare 验证（必须在应用自己的会话里过，外部浏览器过了没用） */
function showGmgnWindow() {
  ensureGmgnWindow();
  gmgnWindow.show();
  gmgnWindow.focus();
}

function ensureGmgnWindow() {
  if (gmgnWindow && !gmgnWindow.isDestroyed()) return gmgnWindow;
  gmgnWindow = new BrowserWindow({
    title: "GMGN · 人机验证 / 登录（完成后可关闭）",
    width: 1120,
    height: 780,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: "persist:fomomo-gmgn",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  gmgnWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    gmgnWindow.hide();
  });
  // 只有主框架的新导航才算「加载中」（同 macOS GmgnBridge）。不能用 did-start-loading：gmgn 页面就绪后
  // 子 iframe 还会反复触发它，而 did-finish-load 只对主框架触发一次，状态会永远卡在「加载中」，K 线 / GMGN 喊单全被拒
  gmgnWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) setGmgnState("loading", "页面加载中");
  });
  gmgnWindow.webContents.on("did-finish-load", inspectGmgnPage);
  gmgnWindow.webContents.on("did-fail-load", (_event, code, description) => {
    if (code !== -3) setGmgnState("error", description || `加载失败 ${code}`);
  });
  gmgnWindow.webContents.setWindowOpenHandler(({ url }) => {
    gmgnWindow.loadURL(url);
    return { action: "deny" };
  });
  gmgnWindow.loadURL(GMGN_HOME);
  return gmgnWindow;
}

async function inspectGmgnPage() {
  if (!gmgnWindow || gmgnWindow.isDestroyed()) return;
  try {
    const result = await gmgnWindow.webContents.executeJavaScript("({title: document.title, host: location.hostname})", true);
    const title = String(result?.title || "");
    const host = String(result?.host || "");
    if (/just a moment|attention required|cloudflare/i.test(title)) {
      setGmgnState("attention", "需要完成 Cloudflare 验证");
      notifyGmgnAttention();
    } else if (host.endsWith("gmgn.ai")) {
      setGmgnState("ready", "GMGN 已连接");
    }
  } catch (error) {
    setGmgnState("error", error.message);
  }
}

/**
 * gmgn 要人机验证：不再把窗口弹到最前面抢焦点（正在打字会打进 gmgn 页面），只发一条托盘提醒，
 * 底栏 gmgn 同时变红；点提醒或底栏再打开窗口。10 分钟内最多提醒一次，接口反复 403 也不刷屏
 */
function notifyGmgnAttention() {
  if (Date.now() - gmgnNotifiedAt < 10 * 60_000) return;
  gmgnNotifiedAt = Date.now();
  showBalloon("gmgn 需要人机验证", "行情和 K 线暂停更新。点这里打开 gmgn 窗口完成验证，完成后关掉窗口即可。", showGmgnWindow);
}

function setGmgnState(state, message) {
  gmgnState = state;
  gmgnMessage = message;
  broadcastEvent({ t: "bridge_status", bridge: "gmgn", state, message });
}

async function waitForGmgn(timeoutMs = 8000) {
  ensureGmgnWindow();
  const end = Date.now() + timeoutMs;
  while (gmgnState !== "ready" && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 250));
  if (gmgnState !== "ready") throw new Error(`gmgn not ready: ${gmgnMessage || gmgnState}`);
}

async function gmgnFetch(params) {
  await waitForGmgn();
  const pathValue = typeof params?.path === "string" ? params.path : "";
  const method = params?.method === "POST" ? "POST" : "GET";
  if (!pathValue.startsWith("/")) throw new Error("bad gmgn path");
  const input = JSON.stringify({ path: pathValue, method, body: params?.body ?? null, fallback: GMGN_FALLBACK_QUERY });
  const script = `(async () => {
    const p = ${input};
    const fromPage = (performance.getEntriesByType('resource').map(e => e.name)
      .find(u => u.includes('gmgn.ai/') && u.includes('device_id=')) || '').split('?')[1];
    const qs = fromPage || p.fallback;
    const body = p.body == null ? null : (typeof p.body === 'string' ? p.body : JSON.stringify(p.body));
    const r = await fetch('https://gmgn.ai' + p.path + (p.path.includes('?') ? '&' : '?') + qs, {
      method: p.method,
      credentials: 'include',
      headers: body == null ? {} : {'Content-Type': 'application/json'},
      body: body == null ? undefined : body,
    });
    return {status: r.status, body: (await r.text()).slice(0, 2000000)};
  })()`;
  const result = await gmgnWindow.webContents.executeJavaScript(script, true);
  if (result?.status === 403 || result?.status === 429 || (result?.status === 200 && !/^[\[{]/.test(result?.body || ""))) {
    setGmgnState("attention", `API ${result?.status || "返回挑战页"}`);
    if (Date.now() - gmgnReloadAt > 60_000) {
      gmgnReloadAt = Date.now();
      gmgnWindow.loadURL(GMGN_HOME);
    }
    notifyGmgnAttention();
  }
  return result;
}

function ensureFomoWindow() {
  if (fomoWindow && !fomoWindow.isDestroyed()) return fomoWindow;
  const partition = "persist:fomomo-family";
  // Google 登录拒绝带 Electron / 应用名的 UA（「此浏览器或应用可能不安全」）：去掉这两段，按普通 Chrome 访问（同 macOS 固定 Safari UA）
  session.fromPartition(partition).setUserAgent(app.userAgentFallback.replace(/ (?:Electron|fomomo)\/\S+/gi, ""));
  fomoWindow = new BrowserWindow({
    title: "fomo.family · 登录（可选）",
    width: 1280,
    height: 820,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  fomoWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    fomoWindow.hide();
  });
  fomoWindow.webContents.setWindowOpenHandler(({ url }) => {
    fomoWindow.loadURL(url);
    return { action: "deny" };
  });
  // 主页面加载失败（代理重置连接 / 超时）：5s 后重试，别让隐藏窗口停在错误页上（-3 = 被新导航中止，不算失败）
  fomoWindow.webContents.on("did-fail-load", (_event, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    log("fomo", `load failed ${code} ${desc}: ${url}`);
    setTimeout(() => { if (fomoWindow && !fomoWindow.isDestroyed()) fomoWindow.webContents.reload(); }, 5000);
  });
  attachFomoDebugger();
  fomoWindow.loadURL("https://fomo.family/");
  return fomoWindow;
}

function attachFomoDebugger() {
  if (!fomoWindow || fomoWindow.webContents.debugger.isAttached()) return;
  try {
    fomoWindow.webContents.debugger.attach("1.3");
    void fomoWindow.webContents.debugger.sendCommand("Network.enable");
    fomoWindow.webContents.debugger.on("message", (_event, method, params) => {
      if (method === "Network.requestWillBeSent") {
        const req = params.request || {};
        const url = String(req.url || "");
        const auth = headerValue(req.headers, "authorization");
        if (url.includes("prod-api.fomo.family") && /^Bearer\s+\S+/i.test(auth || "")) fomoToken = auth.replace(/^Bearer\s+/i, "");
      } else if (method === "Network.responseReceived") {
        const url = String(params.response?.url || "").split("?")[0];
        if (/prod-api\.fomo\.family\/v2\/users\/?$/.test(url)) fomoResponses.set(params.requestId, true);
      } else if (method === "Network.loadingFinished" && fomoResponses.delete(params.requestId)) {
        void readFomoMeResponse(params.requestId);
      }
    });
  } catch (error) {
    log("fomo", `debugger attach failed: ${error.message}`);
  }
}

function headerValue(headers, wanted) {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === wanted);
  return key ? String(headers[key]) : null;
}

async function readFomoMeResponse(requestId) {
  if (!fomoWindow || !fomoWindow.webContents.debugger.isAttached()) return;
  try {
    const payload = await fomoWindow.webContents.debugger.sendCommand("Network.getResponseBody", { requestId });
    const json = JSON.parse(payload.base64Encoded ? Buffer.from(payload.body, "base64").toString("utf8") : payload.body);
    const user = json?.responseObject;
    if (user?.id) {
      fomoMe = { userId: String(user.id), handle: String(user.userHandle || ""), following: typeof user.following === "number" ? user.following : null };
      if (fomoWindow.isVisible()) fomoWindow.hide();
    }
  } catch (error) {
    log("fomo", `cannot read /v2/users response: ${error.message}`);
  }
}

/**
 * 页面在启动时就隐藏加载了；那一刻代理抽风（连接被重置）会让某个脚本没下载下来，页面半残：登录框能开但 Privy 永远不初始化。
 * 所以没登录时每次打开窗口都重载一次（窗口已在显示 = 用户正在登录，不打断）
 */
function showFomoLogin() {
  const existed = !!fomoWindow && !fomoWindow.isDestroyed();
  ensureFomoWindow();
  if (existed && !fomoMe && !fomoWindow.isVisible()) fomoWindow.reload();
  fomoWindow.show();
  fomoWindow.focus();
}

async function readPageFomoToken() {
  if (!fomoWindow || fomoWindow.isDestroyed()) return null;
  try {
    return await fomoWindow.webContents.executeJavaScript(`(() => {
      try {
        const raw = localStorage.getItem('privy:token');
        if (raw) {
          const value = raw[0] === '"' ? JSON.parse(raw) : raw;
          if (typeof value === 'string' && value.split('.').length === 3) return value;
        }
      } catch {}
      const m = document.cookie.match(/(?:^|;\\s*)privy-token=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    })()`, true);
  } catch {
    return null;
  }
}

async function getFomoToken(refresh) {
  ensureFomoWindow();
  const before = fomoToken || await readPageFomoToken();
  if (!refresh || Date.now() - fomoReloadAt < 60_000) return before;
  fomoReloadAt = Date.now();
  fomoWindow.reload();
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const token = fomoToken || await readPageFomoToken();
    if (token && token !== before) return token;
  }
  return fomoToken || await readPageFomoToken();
}

async function handleRpc(event) {
  const id = Number(event.id);
  if (!Number.isInteger(id)) return;
  try {
    let result;
    if (event.method === "gmgn.fetch") result = await gmgnFetch(event.params);
    else if (event.method === "fomo.token") result = { token: await getFomoToken(!!event.params?.refresh) };
    else if (event.method === "fomo.me") result = fomoMe;
    else throw new Error(`unknown method ${event.method}`);
    sendSidecar({ t: "rpc_result", id, ok: true, result });
  } catch (error) {
    sendSidecar({ t: "rpc_result", id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function registerIpc() {
  ipcMain.handle("fomomo:bootstrap", () => bootstrap());
  ipcMain.handle("fomomo:detail", () => selectedAddress ? resolveToken({ address: selectedAddress, chainHint: selectedChain }) : null);
  ipcMain.on("fomomo:command", (_event, command) => {
    if (!command || !ALLOWED_COMMANDS.has(command.t)) return;
    if (command.t === "front_rank_visible") {
      frontRankVisible = Array.isArray(command.addresses) ? command.addresses.filter((a) => typeof a === "string") : [];
      pushFrontRankVisible();
    } else sendSidecar(command);
  });
  // dashboard「设置」页的开机自启；只认 dashboard 窗口发来的。开发模式下 execPath 是 electron.exe，自启会打开空壳，不提供
  const fromDashboard = (event) => !!dashboardWindow && event.sender === dashboardWindow.webContents;
  const autoStartState = () => ({ supported: app.isPackaged, enabled: app.isPackaged && app.getLoginItemSettings().openAtLogin });
  ipcMain.handle("fomomo:auto-start", (event, value) => {
    if (!fromDashboard(event)) throw new Error("forbidden");
    if (typeof value === "boolean" && app.isPackaged) app.setLoginItemSettings({ openAtLogin: value });
    return autoStartState();
  });
  ipcMain.on("fomomo:open-detail", (_event, token) => showDetail(token));
  ipcMain.on("fomomo:row-menu", (_event, token) => showRowMenu(token));
  ipcMain.on("fomomo:unmute-token", (_event, address) => { if (typeof address === "string") void setTokenMuted(address, false); });
  ipcMain.on("fomomo:close-detail", hideDetail);
  ipcMain.on("fomomo:pin-detail", pinDetail);
  ipcMain.on("fomomo:open-gmgn", showGmgnWindow);
  ipcMain.on("fomomo:open-fomo", showFomoLogin);
  ipcMain.on("fomomo:resize-panel", (_event, value) => resizePanel(value));
  ipcMain.on("fomomo:open-dashboard", (_event, tab) => showDashboard(typeof tab === "string" ? tab : null));
  ipcMain.on("fomomo:open-external", (_event, url) => openExternal(url));
  ipcMain.on("fomomo:hide-panel", () => overlayWindow?.hide());
  ipcMain.on("fomomo:compact", (_event, value) => toggleCompact(!!value));
  ipcMain.on("fomomo:always-on-top", (_event, value) => setWindowsAlwaysOnTop(!!value));
}

if (gotLock) {
  app.whenReady().then(() => {
    app.setName(APP_NAME);
    app.setAppUserModelId("com.nishuzumi.fomomo");
    registerIpc();
    createOverlayWindow();
    createDetailWindow();
    createTray();
    ensureGmgnWindow();
    ensureFomoWindow();
    startSidecar();
  });
}

app.on("activate", () => showOverlay(true));
// The tray owns the application lifetime; closing/hiding every window should
// not stop Feishu monitoring.
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  quitting = true;
  clearTimeout(restartTimer);
  clearTimeout(savePanelTimer);
  restartTimer = null;
  if (fomoWindow?.webContents?.debugger?.isAttached()) {
    try { fomoWindow.webContents.debugger.detach(); } catch {}
  }
  if (sidecar) {
    try { sidecar.stdin.end(); } catch {}
    try { sidecar.kill(); } catch {}
    sidecar = null;
  }
});
