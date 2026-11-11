import { useCallback, useEffect, useRef, useState } from "react";
import {
  S,
  api,
  enc,
  errorText,
  mem,
  type Accounts,
  type Home,
  type PageData,
  type RequestError,
  type Setup,
  type Skills,
  type Role,
  type Team,
  type Member,
  type Run,
  type ProjectView,
} from "./lib/api";
import { useTheme } from "./lib/theme";
import {
  Actions,
  Button,
  ConfirmDialog,
  Skeleton,
  Tooltip,
  ToggleGroup,
  Tip,
  type AppActions,
  type Confirmation,
  type MessageData,
} from "./shared";
import {
  AccountsPage,
  HomePage,
  MemberPage,
  ProjectPage,
  RolesPage,
  SetupPage,
  SkillsPage,
  TaskPage,
  TeamsPage,
} from "./pages";
function parts(hash: string) {
  try {
    return hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  } catch {
    return [];
  }
}
export async function loadPage(
  hash: string,
  signal: AbortSignal,
): Promise<PageData> {
  const p = parts(hash);
  const [setup, accounts, home] = await Promise.all([
    api<Setup>("setup", undefined, signal),
    api<Accounts>("accounts", undefined, signal),
    api<Home>("state", undefined, signal),
  ]);
  const data: PageData = { setup, accounts, home };
  if (p[0] === "setup")
    data.settings = await api("settings", undefined, signal);
  else if (p[0] === "project" && p[1])
    data.project = await api<ProjectView>(
      "projects/" + enc(p[1]),
      undefined,
      signal,
    );
  else if (p[0] === "run" && p[1])
    data.run = await api<Run>("runs/" + enc(p[1]), undefined, signal);
  else if (p[0] === "teams" || p[0] === "specialists") {
    const [roles, skills] = await Promise.all([
      api<Role[]>("specialists", undefined, signal),
      api<Skills>("skills", undefined, signal),
    ]);
    Object.assign(data, { roles, skills });
    if (p[0] === "teams")
      data.teams = await api<Team[]>("teams", undefined, signal);
  } else if (p[0] === "skills")
    data.skills = await api<Skills>("skills", undefined, signal);
  else if (p[0] === "member" && p[1] && p[2]) {
    const [member, skills] = await Promise.all([
      api<Member>("members/" + enc(p[1]) + "/" + enc(p[2]), undefined, signal),
      api<Skills>("skills", undefined, signal),
    ]);
    Object.assign(data, { member, skills });
  }
  return data;
}
export function App() {
  const [theme, setTheme] = useTheme();
  const [route, setRoute] = useState(location.hash || "#/");
  const [page, setPage] = useState<{ route: string; data: PageData }>();
  const [connection, setConnection] = useState("");
  const [messages, setMessages] = useState<Record<string, MessageData>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<Confirmation | null>(null);
  const [dialogSerial, setDialogSerial] = useState(0);
  const routeRef = useRef(route);
  const first = useRef(true);
  const refreshNow = useRef<() => void>(() => {});
  const trigger = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  const tell = useCallback<AppActions["tell"]>(
    (key, text, success = false, error) =>
      setMessages((m) => ({ ...m, [key]: { text, success, error } })),
    [],
  );
  const refresh = useCallback(() => refreshNow.current(), []);
  const confirm = useCallback(
    (value: Confirmation) => {
      if (!document.querySelector('[data-testid="confirm-dialog"]'))
        trigger.current = document.activeElement as HTMLElement;
      tell("dialog", "");
      setDialogSerial((n) => n + 1);
      setDialog(value);
    },
    [tell],
  );
  const close = useCallback(() => {
    setDialog(null);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
    });
  }, []);
  const act = useCallback<AppActions["act"]>(
    async (key, action, success = S.common.saved) => {
      setPending((p) => ({ ...p, [key]: true }));
      tell(key, "");
      try {
        await action();
        if (success) tell(key, success, true);
        return true;
      } catch (e) {
        tell(key, errorText(e), false, e as RequestError);
        return false;
      } finally {
        if (alive.current) {
          setPending((p) => ({ ...p, [key]: false }));
          refresh();
        }
      }
    },
    [tell, refresh],
  );
  useEffect(() => {
    alive.current = true;
    const change = () => {
      const next = location.hash || "#/";
      if (next === routeRef.current) return;
      routeRef.current = next;
      setRoute(next);
      setMessages({});
      setDialog(null);
      setConnection("");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", change);
    return () => {
      alive.current = false;
      window.removeEventListener("hashchange", change);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let generation = 0;
    async function poll() {
      clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      const n = ++generation;
      try {
        const data = await loadPage(route, controller.signal);
        if (stopped || n !== generation) return;
        if (first.current) {
          first.current = false;
          if (data.setup.shouldOpen && route !== "#/setup") {
            location.hash = "#/setup";
            return;
          }
        }
        setPage({ route, data });
        setConnection("");
      } catch (e) {
        if (!stopped && n === generation && !controller.signal.aborted)
          setConnection(errorText(e));
      } finally {
        if (!stopped && n === generation)
          timer = setTimeout(() => void poll(), 2000);
      }
    }
    refreshNow.current = () => void poll();
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [route]);
  const data = page?.route === route ? page.data : undefined;
  const p = parts(route);
  const active = ["member", "teams"].includes(p[0])
    ? "teams"
    : ["specialists", "skills", "accounts", "setup"].includes(p[0])
      ? p[0]
      : "projects";
  const nav = [
    ["projects", "#/", S.nav.projects],
    ["teams", "#/teams", S.nav.teams],
    ["specialists", "#/specialists", S.nav.specialists],
    ["skills", "#/skills", S.nav.skills],
    ["accounts", "#/accounts", S.nav.accounts],
  ];
  return (
    <Actions.Provider
      value={{ messages, pending, tell, act, confirm, refresh }}
    >
      <Tooltip.Provider delayDuration={300}>
        <header className="topbar">
          <div className="topbar-inner">
            <a className="wordmark" href="#/">
              {S.checkpoints.fallbackName}
            </a>
            <nav className="main-nav">
              {nav.map(([id, href, text]) => (
                <Button asChild variant="ghost" size="sm" key={id}>
                  <a
                    href={href}
                    data-testid={"nav-" + id}
                    aria-current={active === id ? "page" : undefined}
                  >
                    {text}
                  </a>
                </Button>
              ))}
            </nav>
            <div className="header-right">
              <div className="header-stats">
                <span>
                  <b>{data?.home.teamsCount ?? S.wording.dash}</b>{" "}
                  {S.common.teamCount}
                </span>
                <span>
                  {!!data?.home.agentsRunning && (
                    <i className="dot pulse working-dot" aria-hidden="true" />
                  )}
                  <b>{data?.home.agentsRunning ?? S.wording.dash}</b>{" "}
                  {S.common.running}
                </span>
                <Tip
                  text={
                    data?.home.memoryBytes == null
                      ? S.wording.memoryMissing
                      : S.wording.memoryHint
                  }
                >
                  <span tabIndex={0}>
                    <b>{data ? mem(data.home.memoryBytes) : S.wording.dash}</b>{" "}
                    {S.common.memory}
                  </span>
                </Tip>
              </div>
              <Button asChild variant="ghost" size="sm">
                <a
                  href="#/setup"
                  data-testid="setup-open"
                  aria-current={active === "setup" ? "page" : undefined}
                >
                  {S.nav.setup}
                </a>
              </Button>
              <ToggleGroup.Root
                type="single"
                value={theme}
                onValueChange={(v) => {
                  if (v === "auto" || v === "light" || v === "dark")
                    setTheme(v);
                }}
                aria-label={S.theme.label}
                data-testid="theme"
                className="theme-switch"
              >
                {(["auto", "light", "dark"] as const).map((t) => (
                  <ToggleGroup.Item key={t} value={t}>
                    {S.theme[t]}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup.Root>
            </div>
          </div>
        </header>
        {connection && (
          <div
            role="status"
            data-testid="connection-message"
            data-message-key="connection"
            className="connection-banner"
          >
            {connection}
          </div>
        )}
        <main
          className={
            p[0] === "project" ? "wide" : p[0] === "setup" ? "setup-main" : ""
          }
        >
          {!data ? (
            <Skeleton />
          ) : (
            <div key={route} className="page-content">
              {p[0] === "setup" ? (
                <SetupPage data={data} />
              ) : p[0] === "accounts" ? (
                <AccountsPage data={data} />
              ) : p[0] === "project" && data.project ? (
                <ProjectPage name={p[1]} data={data} />
              ) : p[0] === "run" && data.run ? (
                <TaskPage data={data} />
              ) : p[0] === "teams" ? (
                <TeamsPage data={data} />
              ) : p[0] === "specialists" ? (
                <RolesPage data={data} />
              ) : p[0] === "skills" ? (
                <SkillsPage data={data} />
              ) : p[0] === "member" && data.member ? (
                <MemberPage team={p[1]} name={p[2]} data={data} />
              ) : (
                <HomePage data={data} />
              )}
            </div>
          )}
        </main>
        <ConfirmDialog key={dialogSerial} dialog={dialog} close={close} />
      </Tooltip.Provider>
    </Actions.Provider>
  );
}
