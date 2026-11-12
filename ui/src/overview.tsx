import { useEffect, useState } from "react";
import { ArrowLeft, Settings, User } from "lucide-react";
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
  formValue,
  limitValue,
  useActions,
} from "./shared";
import { IdentityForm, SetupPage, ToolCards } from "./pages";
import { Progress } from "./project-list";

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
export function TeamCard({
  team,
  rows,
  runs,
  selectTeam,
}: {
  team: Team;
  rows: HelperRow[];
  runs: Run[];
  selectTeam: (team: string) => void;
}) {
  const mine = rows.filter((row) => row.team === team.name);
  const counts = { working: 0, needsYou: 0, inReview: 0, idle: 0 };
  const lines: string[] = [];
  for (const row of mine) {
    const [k] = helperStatus(row);
    counts[k]++;
    if (row.broken) lines.push(fmt(S.home.broken, { name: row.name }));
    else if (k === "working")
      lines.push(
        fmt(S.home.isWorking, {
          name: row.name,
          task: snippet(row.run!.task, 60),
        }),
      );
    else if (k === "needsYou")
      lines.push(
        fmt(S.home.needsYou, { name: row.name, state: row.held || row.run?.held ? S.messageLimit.reached : stateText(row.run!) }),
      );
    else if (k === "inReview")
      lines.push(
        fmt(S.home.toReview, {
          name: row.name,
          task: snippet(row.run!.task, 60),
        }),
      );
  }
  const teamRuns = runs.filter((r) => r.team === team.name);
  const percent = teamRuns.length
    ? Math.round(
        (teamRuns.filter((r) => r.lane === "done").length / teamRuns.length) *
          100,
      )
    : 0;
  const status = (
    [
      ["working", S.home.countWorking],
      ["needsYou", S.home.countNeeds],
      ["inReview", S.home.countReview],
    ] as const
  ).filter(([k]) => counts[k]);
  const where = team.projects.length
    ? fmt(S.home.workingOn, { projects: team.projects.join(", ") })
    : S.home.noProject;
  return (
    <a
      className="team-row"
      href="#/helpers"
      data-testid="home-team"
      data-key={team.name}
      onClick={() => selectTeam(team.name)}
    >
      <div className="page-head">
        <div>
          <h3>{team.name}</h3>
          <Hint>
            {plural(mine.length, S.home.memberOne, S.home.memberMany)}
            {" · "}
            {where}
          </Hint>
        </div>
        <div className="badge-row">
          {status.length ? (
            status.map(([k, text]) => (
              <StatusBadge
                key={k}
                tone={tone(k)}
                text={fmt(text, { count: counts[k] })}
              />
            ))
          ) : (
            <StatusBadge text={S.home.free} muted />
          )}
        </div>
      </div>
      <p>
        {lines.length
          ? lines.slice(0, 3).join(" ") +
            (lines.length > 3
              ? " " + fmt(S.home.more, { count: lines.length - 3 })
              : "")
          : S.home.idleTeam}
      </p>
      {!!teamRuns.length && <Progress percent={percent} />}
    </a>
  );
}
export function WeekTasks({ runs, now }: { runs: Run[]; now: Date }) {
  const [mode, setMode] = useState("calendar");
  const [picked, setPicked] = useState(dayKey(now));
  const days = weekOf(now);
  const selectedDay = days.some((d) => dayKey(d) === picked)
    ? picked
    : dayKey(now);
  const byDay = new Map(days.map((d) => [dayKey(d), [] as Run[]]));
  for (const r of runs) byDay.get(dayKey(new Date(r.startedAt!)))?.push(r);
  const shown =
    mode === "list"
      ? [...days].reverse().flatMap((d) => byDay.get(dayKey(d))!)
      : byDay.get(selectedDay)!;
  return (
    <Card className="panel week-panel">
      <div className="page-head">
        <h2>{S.home.week}</h2>
        <div className="button-row">
          {[
            ["calendar", S.home.calendar],
            ["list", S.home.list],
          ].map(([k, text]) => (
            <Button
              key={k}
              variant="outline"
              data-testid="home-mode"
              data-key={k}
              aria-pressed={mode === k}
              onClick={() => setMode(k)}
            >
              {text}
            </Button>
          ))}
        </div>
      </div>
      {mode === "calendar" && (
        <div className="week-days">
          {days.map((d) => {
            const k = dayKey(d),
              count = byDay.get(k)!.length;
            return (
              <button
                key={k}
                className="week-day"
                data-testid="home-day"
                data-key={k}
                aria-pressed={selectedDay === k}
                onClick={() => setPicked(k)}
              >
                <span>
                  {k === dayKey(now)
                    ? S.home.today
                    : d.toLocaleDateString(undefined, { weekday: "short" })}
                </span>
                <strong>{d.getDate()}</strong>
                <small>
                  {count ? plural(count, S.home.taskOne, S.home.taskMany) : ""}
                </small>
              </button>
            );
          })}
        </div>
      )}
      {shown.length ? (
        <Table
          headers={[
            S.tasks.started,
            S.tasks.task,
            S.helpers.helper,
            S.tasks.project,
          ]}
        >
          {shown.map((r) => {
            const at = new Date(r.startedAt!);
            return (
              <tr key={r.runId} data-testid="home-task" data-key={r.runId}>
                <td>
                  {dayKey(at) === dayKey(now)
                    ? S.home.today
                    : at.toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                  {", "}
                  {at.toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </td>
                <td>
                  <a
                    className="link"
                    href={"#/run/" + enc(r.runId)}
                    title={r.task}
                  >
                    {snippet(r.task, 90)}
                  </a>
                </td>
                <td>
                  {whoText(r)}
                  {" · "}
                  {stateText(r)}
                </td>
                <td>
                  <a className="link" href={"#/project/" + enc(r.project)}>
                    {r.project}
                  </a>
                </td>
              </tr>
            );
          })}
        </Table>
      ) : (
        <Hint>{mode === "list" ? S.home.noWeek : S.home.noDay}</Hint>
      )}
    </Card>
  );
}
export function HomePage({
  data,
  newProject,
  selectTeam,
}: {
  data: PageData;
  newProject: () => void;
  selectTeam: (team: string) => void;
}) {
  const now = new Date(),
    teams = data.teams || [],
    runs = data.home.runs;
  const rows = helperRows(teams, runs, data.home.projects.map((project) => project.name), data.home.coordinator?.settings),
    notes = homeNotes(rows, runs, data.setup),
    count = notes.reduce((n, note) => n + note.count, 0);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greeting(now, data.setup.profileName)}</h1>
          <p className="description" data-testid="home-summary">
            {now.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
            {" · "}
            {count
              ? plural(count, S.home.itemOne, S.home.itemMany)
              : S.home.itemNone}
          </p>
        </div>
        <Button data-testid="home-new-project" onClick={newProject}>
          {S.home.newProject}
        </Button>
      </div>
      <div className="home-grid">
        <WeekTasks runs={runs} now={now} />
        <Card className="panel" data-testid="home-teams">
          <div className="page-head">
            <h2>{S.home.teams}</h2>
            <a className="link hint" href="#/helpers">
              {S.home.viewHelpers}
            </a>
          </div>
          {teams.length ? (
            teams.map((t) => (
              <TeamCard
                key={t.name}
                team={t}
                rows={rows}
                runs={runs}
                selectTeam={selectTeam}
              />
            ))
          ) : (
            <p>
              {S.home.noTeams}{" "}
              <a className="link" href="#/teams">
                {S.home.addTeam}
              </a>
            </p>
          )}
        </Card>
        <Card className="panel" data-testid="home-important">
          <h2>{S.home.important}</h2>
          {notes.length ? (
            notes.map((note, i) => (
              <a
                key={i}
                className="home-note"
                href={note.href}
                data-testid="home-note"
              >
                <strong>{note.title}</strong>
                <Hint>{note.body}</Hint>
              </a>
            ))
          ) : (
            <div className="home-note" data-testid="home-note">
              <strong>{S.home.calm}</strong>
              <Hint>{S.home.calmHint}</Hint>
            </div>
          )}
        </Card>
      </div>
    </>
  );
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
  const key = tab === "setup" ? "setup" : "info";
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
        ) : (
          <>
            <div>
              <h1>{S.profile.info}</h1>
              <p className="description">{S.profile.infoHint}</p>
            </div>
            <Card className="panel">
              <IdentityForm data={data} plain />
            </Card>
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
