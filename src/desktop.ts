/** Electron lifecycle around the existing dashboard; no engine state lives here. */
import type * as Electron from "electron";
import { startDashboard, type Dashboard } from "./dashboard.js";

type Desktop = Pick<typeof Electron, "app" | "BrowserWindow" | "Menu" | "shell" | "dialog">;

export async function runDesktop(
  { app, BrowserWindow, Menu, shell, dialog }: Desktop,
  icon: string,
  start: typeof startDashboard = startDashboard,
): Promise<void> {
  // Acquire before readiness or starting a listener: a second click only focuses.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  let window: Electron.BrowserWindow | undefined;
  let dashboard: Dashboard | undefined;
  let stopping = false;
  let stopped = false;
  let closing: Promise<void> | undefined;
  const checks = new AbortController();
  const closeDashboard = () => {
    checks.abort(); // Stop our transient version/auth checks, never detached helpers.
    return closing ??= dashboard?.close() ?? Promise.resolve();
  };
  const focus = () => {
    if (stopping || !window || window.isDestroyed()) return;
    // Xwayland can iconify a window without updating Electron's minimized flag.
    if (window.isMinimized() || !window.isVisible() || !window.isFocused()) window.restore();
    window.show();
    if (process.platform === "darwin") app.focus({ steal: true });
    window.focus();
    if (process.platform === "linux" && !window.isFocused()) {
      // Help window managers that ignore a plain focus request on relaunch.
      const wasOnTop = window.isAlwaysOnTop();
      window.setAlwaysOnTop(true);
      try { window.focus(); } finally { window.setAlwaysOnTop(wasOnTop); }
    }
  };
  app.on("second-instance", focus);
  app.on("activate", () => {
    if (stopping) return;
    if (window && !window.isDestroyed()) focus();
    else if (dashboard) void openWindow().catch(failed);
    // Before startup finishes, startup itself opens and focuses the window.
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    // Also covers quitting while readiness / server startup is still pending.
    void startup.catch(() => {}).then(closeDashboard).finally(() => {
      stopped = true;
      app.quit();
    });
  });

  let opening: Promise<void> | undefined;
  const openWindow = () => opening ??= createWindow().finally(() => { opening = undefined; });
  const createWindow = async () => {
    if (stopping || !dashboard) return;
    const origin = `http://127.0.0.1:${dashboard.port}`;
    const current = window = new BrowserWindow({
      title: "Codec", icon, width: 1200, height: 820,
      minWidth: 720, minHeight: 520, show: false, autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "codec-desktop" },
    });
    window.setMenu(null);
    window.on("closed", () => {
      if (window === current) window = undefined;
      app.quit(); // macOS follows the owner's close = stop expectation too.
    });
    window.on("page-title-updated", (event) => event.preventDefault());
    const external = (address: string) => {
      try {
        const url = new URL(address);
        if (url.origin !== origin && ["https:", "http:"].includes(url.protocol)
            && !url.username && !url.password) {
          void shell.openExternal(url.href).catch(() => {
            dialog.showErrorBox("Codec", "The link could not be opened in your browser.");
          });
        }
      } catch { /* Refuse malformed addresses and non-web protocols. */ }
    };
    const navigation = (event: Electron.Event, address: string) => {
      try { if (new URL(address).origin === origin) return; } catch { /* Block below. */ }
      event.preventDefault();
      external(address);
    };
    window.webContents.on("will-navigate", navigation);
    window.webContents.on("will-redirect", navigation);
    window.webContents.setWindowOpenHandler(({ url }) => {
      // Accounts uses a normal web link: sign-in opens in the owner's browser.
      external(url);
      return { action: "deny" };
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    // Seed the existing HttpOnly cookie directly. No token in URLs, argv or logs.
    await window.webContents.session.cookies.set({
      url: `${origin}/`, name: `codec_token_${dashboard.port}`, value: dashboard.token,
      httpOnly: true, sameSite: "strict", path: "/",
    });
    if (stopping || !window || window.isDestroyed()) return;
    await window.loadURL(`${origin}/`);
    focus();
  };
  const failed = async () => {
    // Electron load errors can contain private URLs: show a fixed message only.
    await closeDashboard();
    if (!stopping) {
      dialog.showErrorBox("Codec", "Codec could not open its dashboard. Close the app and try again.");
      app.exit(1);
    }
  };
  const startup = app.whenReady().then(async () => {
    if (stopping) return;
    Menu.setApplicationMenu(null);
    if (process.platform === "darwin") app.dock?.setIcon(icon);
    dashboard = await start({ port: 0, setup: { signal: checks.signal } });
    if (!stopping) await openWindow();
  });
  try { await startup; } catch { await failed(); }
}
