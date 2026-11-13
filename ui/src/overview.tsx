import { useEffect, useState } from "react";
import { ArrowLeft, Palette, Settings, User } from "lucide-react";
import { useTheme } from "./lib/theme";
import {
  S,
  api,
  enc,
  errorText,
  fmt,
  LANES,
  memberHref,
  snippet,
  stateText,
  toolName,
  toolOK,
  toolProblem,
  whoText,
  type CoordinatorView,
  type Lane,
  type PageData,
  type Run,
  type Setup,
  type Team,
} from "./lib/api";
import {
  Button,
  Card,
  Input,
  Field,
  Form,
  Hint,
  Limit,
  Message,
  Notice,
  Picker,
  StatusBadge,
  Submit,
  Table,
  ToggleGroup,
  formValue,
  limitValue,
  useActions,
} from "./shared";
import { IdentityForm, SetupPage, ToolCards } from "./pages";

export const plural = (count: number, one: string, many: string) =>
  fmt(count === 1 ? one : many, { count });
export const initials = (name?: string) =>
  (name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0])
    .join("")
    .toUpperCase();
export const dayKey = (d: Date) =>
  d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
export function weekOf(now: Date) {
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - ((now.getDay() + 6) % 7),
  );
  return Array.from(
    { length: 7 },
    (_, i) =>
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i),
  );
}
export function greeting(now: Date, name?: string) {
  const hour = now.getHours();
  const part =
    hour < 12 ? S.home.morning : hour < 18 ? S.home.afternoon : S.home.evening;
  const first = (name || "").trim().split(/\s+/)[0];
  return first ? fmt(S.home.named, { greeting: part, name: first }) : part;
}
export function ago(iso?: string) {
  if (!iso) return S.common.unknown;
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 60000),
  );
  return minutes < 1
    ? S.time.now
    : minutes < 60
      ? fmt(S.time.minutes, { count: minutes })
      : minutes < 1440
        ? fmt(S.time.hours, { count: Math.floor(minutes / 60) })
        : fmt(S.time.days, { count: Math.floor(minutes / 1440) });
}
export interface HelperRow {
  key: string;
  name: string;
  team?: string;
  tool: string;
  broken?: boolean;
  held?: boolean;
  projects: string[];
  sub: string;
  href: string;
  run?: Run;
  quick?: boolean;
}
export function helperRows(teams: Team[], runs: Run[], projects: string[] = [], coordinator?: CoordinatorView["settings"]): HelperRow[] {
  const rows: HelperRow[] = [];
  if (coordinator) {
    const mine = runs.filter((run) => run.member === "coordinator" && !run.team);
    const run = mine.find((run) => run.state === "running") || mine[0];
    rows.push({
      key: "coordinator", held: coordinator.held, name: S.coordinator.name, tool: coordinator.tool, projects,
      sub: toolName(coordinator.tool), href: run ? "#/run/" + enc(run.runId) : "#/helpers", run,
    });
  }
  for (const t of teams)
    for (const m of t.members) {
      const name = m.member || m.name!;
      const mine = runs.filter((r) => r.team === t.name && r.member === name);
      rows.push({
        key: t.name + "/" + name,
        name,
        team: t.name,
        tool: m.tool,
        broken: !!m.error,
        held: m.held,
        projects: m.projects || t.projects,
        sub: m.error ? S.helpers.broken : m.specialty || S.members.worker,
        href: memberHref(t.name, name),
        run: mine.find((r) => r.state === "running") || mine[0],
      });
    }
  for (const r of runs)
    if (!r.team && r.lane !== "done" && (r.member !== "coordinator" || !rows.some((row) => row.key === "coordinator")))
      rows.push({
        key: r.member === "coordinator" ? "coordinator" : "run:" + r.runId,
        name: r.member === "coordinator" ? S.coordinator.name : S.helpers.quick,
        tool: r.agent,
        quick: r.member !== "coordinator",
        projects: r.member === "coordinator" ? projects : [r.project],
        sub: toolName(r.agent),
        href: "#/run/" + enc(r.runId),
        run: r,
      });
  return rows;
}
export function helperStatus(
  row: HelperRow,
): [Exclude<Lane, "done"> | "idle", string] {
  if (row.held || row.run?.held) return ["needsYou", S.tasks.needsYou];
  if (row.broken) return ["needsYou", S.helpers.broken];
  const lane = row.run?.lane;
  return lane === "working" || lane === "needsYou" || lane === "inReview"
    ? [lane, LANES.find(([k]) => k === lane)![1]]
    : ["idle", S.members.idle];
}
const tone = (lane: Lane | "idle") =>
  lane === "needsYou"
    ? "needs"
    : lane === "inReview"
      ? "review"
      : lane === "idle"
        ? "muted"
        : lane;
export function homeNotes(rows: HelperRow[], runs: Run[], setup: Setup) {
  const notes: {
    tone?: Lane;
    count: number;
    title: string;
    body: string;
    href: string;
  }[] = [];
  const list = (items: Run[]) =>
    items
      .slice(0, 2)
      .map((r) => whoText(r) + ": " + snippet(r.task, 60))
      .join(" · ") +
    (items.length > 2
      ? " " + fmt(S.home.more, { count: items.length - 2 })
      : "");
  const href = (items: Run[]) =>
    items.length === 1 ? "#/run/" + enc(items[0].runId) : "#/helpers";
  const needs = runs.filter((r) => r.lane === "needsYou");
  if (needs.length)
    notes.push({
      tone: "needsYou",
      count: needs.length,
      title: plural(needs.length, S.home.needsOne, S.home.needsMany),
      body: list(needs),
      href: href(needs),
    });
  const broken = rows.filter((row) => row.broken);
  if (broken.length)
    notes.push({
      tone: "needsYou",
      count: broken.length,
      title: plural(broken.length, S.home.brokenOne, S.home.brokenMany),
      body: broken
        .map((row) =>
          fmt(S.wording.helperTeam, { team: row.team, member: row.name }),
        )
        .join(", "),
      href: broken[0].href,
    });
  const review = runs.filter((r) => r.lane === "inReview");
  if (review.length)
    notes.push({
      tone: "inReview",
      count: review.length,
      title: plural(review.length, S.home.reviewOne, S.home.reviewMany),
      body: list(review),
      href: href(review),
    });
  const used = new Set(rows.filter((row) => row.team).map((row) => row.tool));
  const anyReady = setup.tools.some((t) => toolOK(setup, t.tool));
  for (const t of setup.tools)
    if (!toolOK(setup, t.tool) && (used.has(t.tool) || !anyReady))
      notes.push({
        count: 1,
        title: fmt(S.home.toolTitle, { tool: toolName(t.tool) }),
        body: toolProblem(setup, t.tool),
        href: "#/profile/setup",
      });
  if (setup.identityReady === false)
    notes.push({
      count: 1,
      title: S.home.identityTitle,
      body: S.home.identityHint,
      href: "#/profile",
    });
  return notes;
}
function HelperCompose({ row, data }: { row: HelperRow; data: PageData }) {
  const [project, setProject] = useState(row.projects[0] || "");
  if (row.quick) return <Hint>{S.helpers.quickHint}</Hint>;
  if (row.broken) return null;
  if (!row.projects.length) return <Hint>{S.helpers.noProjects}</Hint>;
  const key = "helper-" + row.key;
  return (
    <Form
      id="helper-task-form"
      actionKey={key}
      success={S.helpers.started}
      onSubmit={async (f) => {
        await api("projects/" + enc(project) + "/runs", {
          member: row.key,
          task: formValue(f, "helper-task-text"),
        });
        f.reset();
      }}
    >
      <Picker
        id="helper-task-project"
        label={S.tasks.project}
        value={project}
        onChange={setProject}
        options={row.projects.map((p) => ({ value: p, label: p }))}
      />
      <Field
        id="helper-task-text"
        label={S.tasks.task}
        required
        placeholder={fmt(S.helpers.compose, { name: row.name })}
      />
      {!toolOK(data.setup, row.tool) && (
        <Notice>
          {toolProblem(data.setup, row.tool)}{" "}
          <a className="link" href="#/profile/setup">
            {S.nav.setup}
          </a>
        </Notice>
      )}
      <Submit
        id="helper-task-start"
        actionKey={key}
        disabled={!toolOK(data.setup, row.tool)}
      >
        {S.tasks.start}
      </Submit>
    </Form>
  );
}
function HelperDetail({ row, data }: { row: HelperRow; data: PageData }) {
  const { confirm, tell } = useActions();
  const [detail, setDetail] = useState<Run>();
  const runId = row.run?.runId;
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    void api<Run>("runs/" + enc(runId), undefined, controller.signal)
      .then((r) => {
        setDetail(r);
        tell("helper-detail", "");
      })
      .catch((e) => {
        if (!controller.signal.aborted) tell("helper-detail", errorText(e));
      });
    return () => controller.abort();
  }, [runId, data.home, tell]);
  const r = detail?.runId === runId ? detail : row.run;
  const [k] = helperStatus(row);
  const lines =
    r?.log
      ?.split("\n")
      .filter((line) => line.trim())
      .slice(-12) || [];
  return (
    <>
      <div>
        <h2>
          <a className="link" href={row.href}>
            {row.name}
          </a>
        </h2>
        <Hint>
          {row.sub}
          {row.team ? " · " + row.team : ""}
        </Hint>
      </div>
      {row.broken ? (
        <Notice>
          <strong>{S.helpers.broken}</strong>
          <p>{S.members.broken}</p>
          <a className="link" href={row.href}>
            {S.helpers.openHelper}
          </a>
        </Notice>
      ) : k !== "idle" && r ? (
        <Notice tone={k === "needsYou" ? "needs" : undefined}>
          <strong>
            {k === "working"
              ? S.helpers.workingOn
              : k === "inReview"
                ? S.tasks.inReview
                : S.tasks.needsYou}
          </strong>
          <p>
            {k === "working"
              ? ""
              : (k === "inReview" ? S.wording.reviewHint : stateText(r)) +
                " · "}
            {snippet(r.task, 200)}
            {k === "working" ? " · " + r.project : ""}
          </p>
          <div className="button-row">
            <Button asChild>
              <a href={"#/run/" + enc(r.runId)}>{S.helpers.openTask}</a>
            </Button>
            {k === "working" && (
              <Button
                variant="destructive"
                data-testid="helper-stop"
                onClick={() =>
                  confirm({
                    title: S.tasks.stopTitle,
                    effects: [
                      {
                        what: fmt(S.tasks.stopEffect, { name: r.runId }),
                        kind: "lost",
                      },
                    ],
                    label: S.tasks.stop,
                    action: () => api("runs/" + enc(r.runId) + "/stop", {}),
                  })
                }
              >
                {S.tasks.stop}
              </Button>
            )}
          </div>
        </Notice>
      ) : null}
      <section>
        <h2>{S.helpers.activity}</h2>
        {lines.length ? (
          <ul className="helper-activity">
            {lines.map((line, i) => (
              <li key={i}>{snippet(line, 160)}</li>
            ))}
          </ul>
        ) : (
          <Hint>{S.helpers.noActivity}</Hint>
        )}
        {r && (
          <a className="link hint" href={"#/run/" + enc(r.runId)}>
            {S.helpers.fullActivity}
          </a>
        )}
        <Message actionKey="helper-detail" />
      </section>
      <HelperCompose key={row.key} row={row} data={data} />
    </>
  );
}
function CoordinatorForm({ data, saved }: { data: PageData; saved: () => void }) {
  const settings = data.home.coordinator?.settings;
  const [tool, setTool] = useState(settings?.tool || "claude");
  return (
    <Form id="coordinator-form" actionKey="coordinator" onSubmit={async (form) => {
      await api("coordinator", {
        tool, model: formValue(form, "coordinator-model"),
        timeLimitMinutes: limitValue(form, "coordinator-limit"),
      });
      saved();
    }}>
      <Picker id="coordinator-tool" label={S.common.tool} value={tool} onChange={setTool}
        options={["claude", "codex"].map((value) => ({ value, label: toolName(value) }))} />
      <Field id="coordinator-model" label={S.common.model} defaultValue={settings?.model} />
      <Limit id="coordinator-limit" value={settings?.timeLimitMinutes} />
      <div className="button-row">
        <Submit id="coordinator-save" actionKey="coordinator">{S.common.save}</Submit>
        {settings && <Button variant="outline" onClick={saved}>{S.common.cancel}</Button>}
      </div>
    </Form>
  );
}

function CoordinatorCard({ data }: { data: PageData }) {
  const [editing, setEditing] = useState(false);
  const { settings, running } = data.home.coordinator ?? { settings: null, running: false };
  const current = data.home.runs.find((run) => run.member === "coordinator" && !run.team && run.state === "running");
  return (
    <Card className="panel" data-testid="coordinator-card">
      <h2>{S.coordinator.name}</h2>
      <Hint>{S.coordinator.explanation}</Hint>
      {settings && <p>{toolName(settings.tool)} · {settings.model || S.common.defaultModel} · {running ? S.tasks.working : S.home.free}</p>}
      {!settings || editing ? <CoordinatorForm data={data} saved={() => setEditing(false)} /> : (
        <div className="button-row">
          <Button variant="outline" onClick={() => setEditing(true)}>{S.coordinator.change}</Button>
          <Button asChild><a href={current ? "#/run/" + enc(current.runId) : "#/projects"}>{current ? S.helpers.openTask : S.helpers.startTask}</a></Button>
        </div>
      )}
      {settings && !editing && <Message actionKey="coordinator" />}
    </Card>
  );
}
export function HelpersPage({
  data,
  team,
  setTeam,
}: {
  data: PageData;
  team: string;
  setTeam: (team: string) => void;
}) {
  const [picked, setPicked] = useState(() => {
    const rows = helperRows(data.teams || [], data.home.runs, data.home.projects.map((project) => project.name), data.home.coordinator?.settings).filter(
      (row) => !team || row.team === team,
    );
    return (
      (rows.find((row) => helperStatus(row)[0] !== "idle") || rows[0])?.key ||
      ""
    );
  });
  const teams = data.teams || [],
    filter = teams.some((t) => t.name === team) ? team : "";
  const rows = helperRows(teams, data.home.runs, data.home.projects.map((project) => project.name), data.home.coordinator?.settings).filter(
    (row) => !filter || row.team === filter,
  );
  const row =
    rows.find((row) => row.key === picked) ||
    rows.find((row) => helperStatus(row)[0] !== "idle") ||
    rows[0];
  useEffect(() => {
    if (row && row.key !== picked) setPicked(row.key);
  }, [row?.key, picked]);
  const counts = { working: 0, inReview: 0, idle: 0, needsYou: 0 };
  for (const row of rows) counts[helperStatus(row)[0]]++;
  return (
    <>
      <div className="page-head">
        <h1>{S.helpers.title}</h1>
        <div className="button-row">
          <Button asChild variant="outline">
            <a href="#/projects">{S.helpers.startTask}</a>
          </Button>
          <Button asChild>
            <a href="#/teams">{S.members.add}</a>
          </Button>
        </div>
      </div>
      <CoordinatorCard data={data} />
      <div className="button-row">
        {[
          { name: "", label: S.helpers.all },
          ...teams.map((t) => ({ name: t.name, label: t.name })),
        ].map((t) => (
          <Button
            key={t.name}
            variant="outline"
            data-testid="helpers-team"
            data-key={t.name}
            aria-pressed={filter === t.name}
            onClick={() => setTeam(t.name)}
          >
            {t.label}
          </Button>
        ))}
      </div>
      <div className="helpers-split">
        <section className="page-content">
          <div className="helper-stats">
            {(
              [
                ["working", S.tasks.working],
                ["inReview", S.tasks.inReview],
                ["idle", S.members.idle],
                ["needsYou", S.tasks.needsYou],
              ] as const
            ).map(([k, text]) => (
              <Card className="panel" key={k}>
                <StatusBadge text={text} tone={tone(k)} />
                <strong className="stat-number">{counts[k]}</strong>
              </Card>
            ))}
          </div>
          {rows.length ? (
            <Table
              headers={[
                S.helpers.helper,
                S.tasks.state,
                S.helpers.current,
                S.tasks.project,
                S.tasks.started,
              ]}
            >
              {rows.map((r) => {
                const [k, text] = helperStatus(r),
                  active = k !== "idle" && r.run;
                return (
                  <tr
                    key={r.key}
                    tabIndex={0}
                    data-testid="helper-row"
                    data-key={r.key}
                    aria-selected={r.key === row?.key}
                    onClick={() => setPicked(r.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setPicked(r.key);
                      }
                    }}
                  >
                    <td>
                      <strong>{r.name}</strong>
                      <Hint>
                        {r.sub}
                        {r.team ? " · " + r.team : ""}
                      </Hint>
                    </td>
                    <td>
                      <StatusBadge text={text} tone={tone(k)} />
                    </td>
                    <td>
                      {active ? snippet(r.run!.task, 90) : S.helpers.noTask}
                    </td>
                    <td>{active ? r.run!.project : S.wording.dash}</td>
                    <td>{r.run ? ago(r.run.startedAt) : S.wording.dash}</td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <Hint>{S.helpers.empty}</Hint>
          )}
        </section>
        <aside
          className="page-content helper-detail"
          data-testid="helper-detail"
        >
          {row ? (
            <HelperDetail key={row.key} row={row} data={data} />
          ) : (
            <Hint>{S.helpers.pick}</Hint>
          )}
        </aside>
      </div>
    </>
  );
}
function ClassesCard({ data }: { data: PageData }) {
  const { act, pending } = useActions();
  const classes = data.settings?.classes ?? data.home.classes ?? [];
  const [name, setName] = useState("");
  const key = "profile-classes";
  const save = (next: string[]) =>
    act(key, () => api("settings", { classes: next }), S.common.saved);
  return (
    <Card className="panel" data-testid="profile-classes">
      <h2>{S.profile.classes}</h2>
      <Hint>{S.profile.classesHint}</Hint>
      {classes.length ? (
        <div className="home-chips">
          {classes.map((c) => (
            <span key={c} className="status tag working class-chip" data-testid="class-chip" data-key={c}>
              {c}
              <button
                type="button"
                aria-label={fmt(S.profile.removeClass, { name: c })}
                title={fmt(S.profile.removeClass, { name: c })}
                disabled={pending[key]}
                onClick={() => void save(classes.filter((x) => x !== c))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <Hint>{S.profile.noClassesYet}</Hint>
      )}
      <form
        className="class-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void save([...classes, name.trim()]).then((ok) => ok && setName(""));
        }}
      >
        <Input
          aria-label={S.profile.classes}
          placeholder={S.profile.classPlaceholder}
          data-testid="class-name"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="outline" data-testid="class-add" disabled={!name.trim() || pending[key]}>
          {S.profile.addClass}
        </Button>
      </form>
      <Message actionKey={key} />
    </Card>
  );
}
export function ProfilePage({
  data,
  tab,
  back,
}: {
  data: PageData;
  tab?: string;
  back: string;
}) {
  const { act, pending } = useActions();
  const key = tab === "setup" || tab === "appearance" ? tab : "info";
  const [theme, setTheme] = useTheme();
  return (
    <div className="profile-layout">
      <nav className="profile-nav" aria-label={S.profile.tabs}>
        <a className="link" href={back} data-testid="profile-back">
          <ArrowLeft aria-hidden="true" />
          {S.profile.back}
        </a>
        {[
          ["info", S.profile.info, User],
          ["setup", S.nav.setup, Settings],
          ["appearance", S.profile.appearance, Palette],
        ].map(([id, label, Icon]) => {
          const Glyph = Icon as typeof User;
          return (
            <Button asChild key={String(id)} variant="ghost">
              <a
                href={"#/profile/" + id}
                data-testid="profile-tab"
                data-key={String(id)}
                aria-current={key === id ? "page" : undefined}
              >
                <Glyph aria-hidden="true" />
                {String(label)}
              </a>
            </Button>
          );
        })}
      </nav>
      <section className="page-content" data-testid={"profile-" + key}>
        {key === "setup" ? (
          <SetupPage data={data} />
        ) : key === "appearance" ? (
          <>
            <div>
              <h1>{S.profile.appearance}</h1>
            </div>
            <Card className="panel">
              <h2>{S.theme.label}</h2>
              <Hint>{S.profile.themeHint}</Hint>
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
                {(["light", "dark", "auto"] as const).map((t) => (
                  <ToggleGroup.Item key={t} value={t}>
                    {S.theme[t]}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup.Root>
            </Card>
          </>
        ) : (
          <>
            <div>
              <h1>{S.profile.info}</h1>
            </div>
            <Card className="panel">
              <IdentityForm data={data} plain />
            </Card>
            <ClassesCard data={data} />
            <Card className="panel">
              <h2>{S.profile.signIns}</h2>
              <Hint>{S.profile.signInsHint}</Hint>
              <ToolCards data={data} okText={S.profile.signedIn} />
              <Button
                variant="outline"
                data-testid="profile-check"
                disabled={pending["profile-check"]}
                onClick={() =>
                  void act("profile-check", () => api("setup?fresh=1"), "")
                }
              >
                {S.profile.recheck}
              </Button>
              <Message actionKey="profile-check" />
            </Card>
          </>
        )}
      </section>
    </div>
  );
}
