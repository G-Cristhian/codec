import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDashboard, type Dashboard } from "../src/dashboard.js";
import { runDesktop } from "../src/desktop.js";
import { helperNodeExecutable } from "../src/runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture() {
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(async () => {}),
    dock: { setIcon: vi.fn() },
    focus: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() };
      app.emit("before-quit", event);
      if (!event.preventDefault.mock.calls.length) app.emit("quit");
    }),
    exit: vi.fn(),
  });
  const cookies = { set: vi.fn(async (_cookie: unknown) => {}) };
  const session = { cookies, setPermissionRequestHandler: vi.fn() };
  class Window extends EventEmitter {
    static instances: Window[] = [];
    webContents = Object.assign(new EventEmitter(), { session, setWindowOpenHandler: vi.fn() });
    destroyed = false;
    minimized = false;
    visible = true;
    focused = true;
    alwaysOnTop = false;
    isDestroyed = () => this.destroyed;
    isMinimized = () => this.minimized;
    isVisible = () => this.visible;
    isFocused = () => this.focused;
    isAlwaysOnTop = () => this.alwaysOnTop;
    setAlwaysOnTop = vi.fn((value: boolean) => { this.alwaysOnTop = value; });
    restore = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    setMenu = vi.fn();
    loadURL = vi.fn(async (_url: string) => {});
    constructor(public options: Record<string, unknown>) { super(); Window.instances.push(this); }
    close() { this.destroyed = true; this.emit("closed"); }
  }
  const shell = { openExternal: vi.fn(async () => {}) };
  const dialog = { showErrorBox: vi.fn() };
  const Menu = { setApplicationMenu: vi.fn() };
  const electron = { app, BrowserWindow: Window, shell, dialog, Menu } as unknown as Parameters<typeof runDesktop>[0];
  const dashboard = {
    port: 54321, token: "private-token", url: "http://127.0.0.1:54321/?token=private-token",
    close: vi.fn(async () => {}),
  } as unknown as Dashboard;
  const start = vi.fn(async () => dashboard);
  return { app, Window, cookies, shell, dialog, Menu, electron, dashboard, start };
}

describe("desktop lifecycle", () => {
  it("hands authentication to the window through an HttpOnly cookie, with no token URL", async () => {
    const f = fixture();
    await runDesktop(f.electron, "/icon.png", f.start);
    expect(f.start).toHaveBeenCalledExactlyOnceWith({ port: 0, setup: { signal: expect.any(AbortSignal) } });
    expect(f.cookies.set).toHaveBeenCalledExactlyOnceWith({
      url: "http://127.0.0.1:54321/", name: "codec_token_54321", value: "private-token",
      httpOnly: true, sameSite: "strict", path: "/",
    });
    const window = f.Window.instances[0];
    expect(window.loadURL).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:54321/");
    expect(f.cookies.set.mock.invocationCallOrder[0]).toBeLessThan(window.loadURL.mock.invocationCallOrder[0]);
    expect(window.options).toMatchObject({ title: "Codec", icon: "/icon.png", webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "codec-desktop",
    } });
    expect(f.Menu.setApplicationMenu).toHaveBeenCalledWith(null);
    expect(window.setMenu).toHaveBeenCalledWith(null);
    const quit = once(f.app, "quit");
    window.close();
    await quit;
    expect(f.dashboard.close).toHaveBeenCalledTimes(1);
  });

  it("a second process exits without starting a server or creating a window", async () => {
    const f = fixture();
    f.app.requestSingleInstanceLock.mockReturnValue(false);
    await runDesktop(f.electron, "/icon.png", f.start);
    expect(f.app.quit).toHaveBeenCalledOnce();
    expect(f.app.whenReady).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.Window.instances).toHaveLength(0);
  });

  it("repeated clicks restore and focus the existing window without another server", async () => {
    const f = fixture();
    const ready = deferred<void>();
    f.app.whenReady.mockReturnValue(ready.promise);
    const opening = runDesktop(f.electron, "/icon.png", f.start);
    f.app.emit("second-instance"); // A click during startup is safe too.
    ready.resolve();
    await opening;
    const window = f.Window.instances[0];
    window.minimized = true;
    f.app.emit("second-instance");
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledTimes(2);
    expect(f.Window.instances).toHaveLength(1);
    expect(f.start).toHaveBeenCalledOnce();
  });

  it("sends web links and popups to the browser, blocking unsafe protocols", async () => {
    const f = fixture();
    await runDesktop(f.electron, "/icon.png", f.start);
    const contents = f.Window.instances[0].webContents;
    const local = { preventDefault: vi.fn() };
    contents.emit("will-navigate", local, "http://127.0.0.1:54321/#/setup");
    expect(local.preventDefault).not.toHaveBeenCalled();
    for (const event of ["will-navigate", "will-redirect"]) {
      const e = { preventDefault: vi.fn() };
      contents.emit(event, e, "https://example.com/docs");
      expect(e.preventDefault).toHaveBeenCalledOnce();
    }
    const popup = contents.setWindowOpenHandler.mock.calls[0][0] as (details: { url: string }) => unknown;
    expect(popup({ url: "https://example.com/" })).toEqual({ action: "deny" });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com/", "invalid"]) {
      const e = { preventDefault: vi.fn() };
      contents.emit("will-navigate", e, url);
      expect(e.preventDefault).toHaveBeenCalledOnce();
      expect(popup({ url })).toEqual({ action: "deny" });
    }
    expect(f.shell.openExternal.mock.calls).toEqual([
      ["https://example.com/docs"], ["https://example.com/docs"], ["https://example.com/"],
    ]);
  });

  it("waits for the server to close before quitting, including repeated quit requests", async () => {
    const f = fixture();
    const closed = deferred<void>();
    vi.mocked(f.dashboard.close).mockReturnValue(closed.promise);
    await runDesktop(f.electron, "/icon.png", f.start);
    const quit = vi.fn();
    f.app.on("quit", quit);
    f.app.quit();
    f.app.quit();
    await vi.waitFor(() => expect(f.dashboard.close).toHaveBeenCalledOnce());
    expect(quit).not.toHaveBeenCalled();
    const done = once(f.app, "quit");
    closed.resolve();
    await done;
    expect(quit).toHaveBeenCalledOnce();
  });

  it("cleans up a server that finishes starting after quit was requested", async () => {
    const f = fixture();
    const starting = deferred<Dashboard>();
    f.start.mockReturnValue(starting.promise);
    const opening = runDesktop(f.electron, "/icon.png", f.start);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    const quit = once(f.app, "quit");
    f.app.quit();
    starting.resolve(f.dashboard);
    await opening;
    await quit;
    expect(f.dashboard.close).toHaveBeenCalledOnce();
    expect(f.Window.instances).toHaveLength(0);
  });

  it("closes the server after a window load failure without displaying private error text", async () => {
    const f = fixture();
    f.cookies.set.mockRejectedValueOnce(new Error(f.dashboard.url));
    await runDesktop(f.electron, "/icon.png", f.start);
    expect(f.dashboard.close).toHaveBeenCalledOnce();
    expect(f.dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.dialog.showErrorBox.mock.calls)).not.toContain(f.dashboard.token);
    expect(f.app.exit).toHaveBeenCalledWith(1);
  });
});

describe("bringing an existing desktop window back", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => { Object.defineProperty(process, "platform", platform); });

  it.each(["linux", "darwin", "win32"])("restores minimized, hidden and unfocused windows on %s", async (os) => {
    Object.defineProperty(process, "platform", { value: os });
    const f = fixture();
    await runDesktop(f.electron, "/icon.png", f.start);
    const window = f.Window.instances[0];
    for (const event of ["second-instance", "activate"]) {
      for (const state of ["minimized", "hidden", "unfocused", "focused"]) {
        window.minimized = state === "minimized";
        window.visible = state !== "hidden";
        window.focused = state !== "unfocused";
        vi.clearAllMocks();
        f.app.emit(event);
        expect(window.restore).toHaveBeenCalledTimes(state === "focused" ? 0 : 1);
        expect(window.show).toHaveBeenCalledOnce();
        expect(window.focus).toHaveBeenCalledTimes(os === "linux" && state === "unfocused" ? 2 : 1);
        const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0];
        if (state !== "focused") expect(order(window.restore)).toBeLessThan(order(window.show));
        expect(order(window.show)).toBeLessThan(order(window.focus));
        if (os === "darwin") {
          expect(f.app.focus).toHaveBeenCalledExactlyOnceWith({ steal: true });
          expect(order(window.show)).toBeLessThan(order(f.app.focus));
          expect(order(f.app.focus)).toBeLessThan(order(window.focus));
        } else expect(f.app.focus).not.toHaveBeenCalled();
        if (os === "linux" && state === "unfocused") {
          expect(window.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
          expect(window.focus.mock.invocationCallOrder[0]).toBeLessThan(order(window.setAlwaysOnTop));
          expect(order(window.setAlwaysOnTop)).toBeLessThan(window.focus.mock.invocationCallOrder[1]);
          expect(window.focus.mock.invocationCallOrder[1]).toBeLessThan(window.setAlwaysOnTop.mock.invocationCallOrder[1]);
        } else expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
        expect(window.alwaysOnTop).toBe(false);
        expect(f.Window.instances).toHaveLength(1);
        expect(f.start).not.toHaveBeenCalled();
      }
    }
  });

  it("skips the Linux workaround when the first focus succeeds", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const f = fixture();
    await runDesktop(f.electron, "/icon.png", f.start);
    const window = f.Window.instances[0];
    window.focused = false;
    window.focus.mockImplementation(() => { window.focused = true; });
    vi.clearAllMocks();
    f.app.emit("second-instance");
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("restores the Linux window's previous always-on-top state even if focus fails", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const f = fixture();
    await runDesktop(f.electron, "/icon.png", f.start);
    const window = f.Window.instances[0];
    window.focused = false;
    window.alwaysOnTop = true;
    window.focus.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("focus failed"); });
    expect(() => f.app.emit("second-instance")).toThrow("focus failed");
    expect(window.setAlwaysOnTop.mock.calls).toEqual([[true], [true]]);
    expect(window.alwaysOnTop).toBe(true);
  });
});

describe("macOS Dock activation", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => { Object.defineProperty(process, "platform", platform); });
  function mac() {
    Object.defineProperty(process, "platform", { value: "darwin" });
    return fixture();
  }

  it("handles activation during startup and restores an existing window", async () => {
    const f = mac();
    const ready = deferred<void>();
    f.app.whenReady.mockReturnValue(ready.promise);
    const opening = runDesktop(f.electron, "/icon.png", f.start);
    f.app.emit("activate");
    ready.resolve();
    await opening;
    const window = f.Window.instances[0];
    window.minimized = true;
    f.app.emit("activate");
    expect(f.app.dock.setIcon).toHaveBeenCalledExactlyOnceWith("/icon.png");
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledTimes(2);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.Window.instances).toHaveLength(1);
    f.app.quit();
    await once(f.app, "quit");
  });

  it("recreates a missing window on activate without starting another server", async () => {
    const f = mac();
    await runDesktop(f.electron, "/icon.png", f.start);
    // Model an activate with no live window, independently of explicit close.
    f.Window.instances[0].destroyed = true;
    f.app.emit("activate");
    f.app.emit("activate");
    await vi.waitFor(() => expect(f.Window.instances[1].focus).toHaveBeenCalled());
    expect(f.Window.instances).toHaveLength(2);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.Window.instances[1].loadURL).toHaveBeenCalledWith("http://127.0.0.1:54321/");
    f.app.quit();
    await once(f.app, "quit");
  });

  it("quits on last-window close on macOS and ignores activate during shutdown", async () => {
    const f = mac();
    const closed = deferred<void>();
    vi.mocked(f.dashboard.close).mockReturnValue(closed.promise);
    await runDesktop(f.electron, "/icon.png", f.start);
    f.Window.instances[0].close();
    f.app.emit("window-all-closed");
    f.app.emit("activate");
    await vi.waitFor(() => expect(f.dashboard.close).toHaveBeenCalledOnce());
    expect(f.Window.instances).toHaveLength(1);
    const quit = once(f.app, "quit");
    closed.resolve();
    await quit;
    expect(f.start).toHaveBeenCalledOnce();
  });
});

describe("desktop free ports and real dashboard authentication", () => {
  const servers: Dashboard[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((d) => d.close())); });
  it("allocates distinct loopback ports, accepts the cookie handoff, then releases the ports", async () => {
    const a = await startDashboard({ port: 0 }); servers.push(a);
    const b = await startDashboard({ port: 0 }); servers.push(b);
    expect(a.port).toBeGreaterThan(0);
    expect(b.port).not.toBe(a.port);
    expect(a.server.address()).toMatchObject({ address: "127.0.0.1" });
    const url = `http://127.0.0.1:${a.port}/`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Cookie: `codec_token_${a.port}=${a.token}` } })).status).toBe(200);
    expect((await fetch(url, { headers: { Cookie: `codec_token_${a.port}=${b.token}` } })).status).toBe(401);
    await Promise.all(servers.splice(0).map((d) => d.close()));
    expect(a.server.listening).toBe(false);
    expect(b.server.listening).toBe(false);
    await expect(fetch(url)).rejects.toThrow();
  });
});

it("keeps regular Node as the helper interpreter inside Electron and preserves CLI behavior", () => {
  expect(helperNodeExecutable("45.1.0", "/usr/bin/node", "/path/to/electron")).toBe("/usr/bin/node");
  expect(helperNodeExecutable("45.1.0", "", "/path/to/electron")).toBe("node");
  expect(helperNodeExecutable("", "/ignored/node", "/cli/node")).toBe("/cli/node");
});
