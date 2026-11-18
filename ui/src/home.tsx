import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Briefcase,
  CalendarDays,
  ChevronRight,
  ClipboardCheck,
  Folder,
  GraduationCap,
  KeyRound,
  Plus,
  Send,
  Sparkles,
  User,
  X,
} from "lucide-react";
import {
  S,
  api,
  enc,
  fmt,
  LANES,
  laneTone,
  projectTagText,
  snippet,
  stateText,
  toolName,
  toolOK,
  whoText,
  type CalendarEvent,
  type EventKind,
  type Lane,
  type PageData,
  type ProjectArea,
  type Run,
  type TaskArea,
} from "./lib/api";
import {
  Button,
  Card,
  Hint,
  Input,
  Message,
  Picker,
  useActions,
  type Option,
} from "./shared";
import { dayKey, greeting, plural, weekOf } from "./overview";
import { go } from "./pages";

/** Tag colours reuse the status tones so they read well in light and dark. */
const TONE: Record<string, string> = {
  school: "working",
  class: "working",
  work: "review",
  personal: "done",
  deadline: "needs",
  meeting: "working",
  interview: "review",
  subscription: "quiet",
  loggedIn: "done",
  loggedOut: "needs",
  limit: "needs",
  decision: "needs",
  pr: "review",
  review: "working",
};
function Tag({ tone, children }: { tone: string; children: string }) {
  return (
    <span className={"status tag " + (TONE[tone] ?? "quiet")} data-testid="tag" data-key={tone}>
      {children}
    </span>
  );
}
/** Padded local day (YYYY-MM-DD), the format calendar events are saved in. */
const isoDay = (d: Date) =>
  d.getFullYear() +
  "-" +
  String(d.getMonth() + 1).padStart(2, "0") +
  "-" +
  String(d.getDate()).padStart(2, "0");

const TASK_AREAS: TaskArea[] = ["school", "work", "personal"];
const EVENT_KINDS: EventKind[] = ["deadline", "meeting", "interview"];

function projectIcon(area?: ProjectArea) {
  if (area === "class") return GraduationCap;
  if (area === "work") return Briefcase;
  if (area === "personal") return User;
  return Folder;
}
function ProjectIcon({ area }: { area?: ProjectArea }) {
  const Icon = projectIcon(area);
  return (
    <span className={"home-icon " + (area ?? "none")} aria-hidden="true">
      <Icon />
    </span>
  );
}

function helperOptions(data: PageData, project: string): Option[] {
  const members = (data.teams || [])
    .filter((t) => t.projects.includes(project))
    .flatMap((t) =>
      t.members.map((m) => ({
        value: "m:" + t.name + "/" + m.member,
        tool: m.tool,
        label: t.name + "/" + m.member,
        group: S.tasks.teamMembers,
      })),
    );
  const coordinator = data.home.coordinator?.settings
    ? [{ value: "m:coordinator", tool: data.home.coordinator.settings.tool, label: S.coordinator.name, group: S.tasks.teamMembers }]
    : [];
  return [
    ...members,
    ...coordinator,
    ...["claude", "codex"].map((t) => ({
      value: "a:" + t,
      tool: t,
      label: fmt(S.wording.quickUsing, { tool: toolName(t) }),
      group: S.tasks.worker,
    })),
  ];
}

function StartTask({ data }: { data: PageData }) {
  const { act, pending } = useActions();
  const projects = data.home.projects;
  const [area, setArea] = useState<TaskArea>("school");
  const [text, setText] = useState("");
  const matching = (a: TaskArea) =>
    projects.find((p) => (a === "school" ? p.area === "class" : p.area === a))?.name;
  const [project, setProject] = useState(matching("school") ?? projects[0]?.name ?? "");
  const options = project ? helperOptions(data, project) : [];
  const [who, setWho] = useState("");
  const whoValue = options.some((o) => o.value === who)
    ? who
    : options.find((o) => toolOK(data.setup, o.tool!))?.value ?? "";
  const key = "home-start";
  function startTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!text.trim() || !whoValue) return;
    void act(
      key,
      async () => {
        const r = await api<{ runId: string }>("projects/" + enc(project) + "/runs", {
          task: text,
          area,
          ...(whoValue.startsWith("m:") ? { member: whoValue.slice(2) } : { agent: whoValue.slice(2) }),
        });
        setText("");
        go("#/run/" + enc(r.runId));
      },
      "",
    );
  }

  return (
    <Card className="panel home-start" data-testid="home-start">
      <div className="home-start-head">
        <span className="home-icon hero" aria-hidden="true">
          <Sparkles />
        </span>
        <div>
          <h2>{S.home.startTitle}</h2>
          <Hint>{S.home.startHint}</Hint>
        </div>
      </div>
      {projects.length ? (
        <form
          className="home-start-form"
          onSubmit={startTask}
        >
          <div className="home-start-input">
            <textarea
              aria-label={S.home.startPlaceholder}
              placeholder={S.home.startPlaceholder}
              data-testid="home-start-text"
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <Button type="submit" data-testid="home-start-run" disabled={!text.trim() || !whoValue || pending[key]}>
              <Send aria-hidden="true" />
              {S.home.run}
            </Button>
          </div>
          <div className="home-start-options">
            <div className="tag-choices" role="group" aria-label={S.home.tag}>
              {TASK_AREAS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={"status tag " + TONE[a]}
                  data-testid="home-start-area"
                  data-key={a}
                  aria-pressed={area === a}
                  onClick={() => {
                    setArea(a);
                    const next = matching(a);
                    if (next) setProject(next);
                  }}
                >
                  {S.tags[a]}
                </button>
              ))}
            </div>
            <Picker
              id="home-start-project"
              label={S.home.project}
              options={projects.map((p) => {
                const tag = projectTagText(p);
                return { value: p.name, label: tag ? p.name + " · " + tag : p.name };
              })}
              value={project}
              onChange={setProject}
            />
            <Picker
              id="home-start-who"
              label={S.home.helper}
              options={options}
              value={whoValue}
              onChange={setWho}
              setup={data.setup}
            />
          </div>
          <Message actionKey={key} />
        </form>
      ) : (
        <Hint>
          {S.home.noProjectsToRun}{" "}
        </Hint>
      )}
    </Card>
  );
}

const LANE_TEXT = Object.fromEntries(LANES) as Record<Lane, string>;

function ProjectTagPicker({
  project,
  classes,
}: {
  project: PageData["home"]["projects"][number];
  classes: string[];
}) {
  const { act } = useActions();
  const value = project.area === "class" ? "class:" + project.className : project.area ?? "";
  return (
    <label className={"tag-select status tag " + (project.area ? TONE[project.area] : "quiet")}>
      <span className="sr-only">{S.home.changeTag}</span>
      <select
        data-testid="project-tag"
        data-key={project.name}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          const body = v.startsWith("class:") ? { area: "class", className: v.slice(6) } : { area: v };
          void act("project-tag-" + project.name, () => api("projects/" + enc(project.name) + "/tag", body), "");
        }}
      >
        <option value="">{project.area ? S.home.clearTag : S.home.untagged}</option>
        {classes.map((c) => (
          <option key={c} value={"class:" + c}>
            {c}
          </option>
        ))}
        {project.area === "class" && project.className && !classes.includes(project.className) && (
          <option value={value}>{project.className}</option>
        )}
        <option value="work">{S.tags.work}</option>
        <option value="personal">{S.tags.personal}</option>
      </select>
    </label>
  );
}

/** Latest task per helper on this project, in the input's newest-first order. */
function projectHelpers(runs: Run[], project: string) {
  const seen = new Set<string>();
  const helpers: Run[] = [];
  for (const run of runs) {
    if (run.project !== project) continue;
    const who = whoText(run);
    if (seen.has(who)) continue;
    seen.add(who);
    helpers.push(run);
  }
  return helpers;
}

function ActiveProjects({ data }: { data: PageData }) {
  const classes = data.home.classes ?? [];
  const runs = data.home.runs;
  const order: Record<string, number> = { class: 0, work: 1, personal: 2 };
  const projects = [...data.home.projects].sort(
    (a, b) => (order[a.area ?? ""] ?? 3) - (order[b.area ?? ""] ?? 3) || a.name.localeCompare(b.name),
  );
  return (
    <Card className="panel" data-testid="home-projects">
      <div className="page-head">
        <div>
          <h2>{S.home.projectsTitle}</h2>
          <Hint>{S.home.projectsHint}</Hint>
        </div>
        <a className="link hint home-more" href="#/projects">
          {S.home.viewProjects}
          <ArrowRight aria-hidden="true" />
        </a>
      </div>
      {!classes.length && (
        <Hint>
          {S.home.noClasses}{" "}
          <a className="link" href="#/profile">
            {S.home.addClasses}
          </a>
        </Hint>
      )}
      {projects.length ? (
        <ul className="home-list">
          {projects.map((p) => {
            const helpers = projectHelpers(runs, p.name);
            return (
              <li key={p.name} className="home-project" data-testid="home-project" data-key={p.name}>
                <ProjectIcon area={p.area} />
                <div className="home-project-body">
                  <div className="home-project-title">
                    <a className="link" href={"#/project/" + enc(p.name)}>
                      <strong>{p.name}</strong>
                    </a>
                    <ProjectTagPicker project={p} classes={classes} />
                  </div>
                  <div className="home-chips">
                    {helpers.length ? (
                      helpers.slice(0, 4).map((r) => (
                        <span key={r.runId} className={"status " + laneTone(r.lane ?? "done")} data-testid="home-project-helper">
                          {fmt(S.home.pendingHelper, { name: whoText(r), state: LANE_TEXT[r.lane ?? "done"] })}
                        </span>
                      ))
                    ) : (
                      <span className="hint">{S.home.noHelpersYet}</span>
                    )}
                  </div>
                </div>
                <a className="home-go" href={"#/project/" + enc(p.name)} aria-label={p.name}>
                  <ChevronRight aria-hidden="true" />
                </a>
              </li>
            );
          })}
        </ul>
      ) : (
        <Hint>{S.home.noProjects}</Hint>
      )}
    </Card>
  );
}

function AddEvent({ day, done }: { day: string; done: () => void }) {
  const { act, pending } = useActions();
  const [kind, setKind] = useState<EventKind>("deadline");
  const key = "home-event";
  function saveEvent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
    void act(key, () => api("calendar", { title: val("event-title"), date: val("event-date"), time: val("event-time"), kind }), "").then(
      (ok) => ok && done(),
    );
  }

  return (
    <form
      className="home-event-form"
      data-testid="home-event-form"
      onSubmit={saveEvent}
    >
      <label className="field">
        <span>{S.home.eventTitle}</span>
        <Input name="event-title" data-testid="event-title" required maxLength={120} />
      </label>
      <label className="field">
        <span>{S.home.eventDate}</span>
        <Input type="date" name="event-date" data-testid="event-date" defaultValue={day} required />
      </label>
      <label className="field">
        <span>{S.home.eventTime}</span>
        <Input type="time" name="event-time" data-testid="event-time" />
      </label>
      <div className="field">
        <span>{S.home.eventKind}</span>
        <div className="tag-choices" role="group" aria-label={S.home.eventKind}>
          {EVENT_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={"status tag " + TONE[k]}
              data-testid="event-kind"
              data-key={k}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
            >
              {S.tags[k]}
            </button>
          ))}
        </div>
      </div>
      <div className="button-row">
        <Button type="submit" data-testid="event-save" disabled={pending[key]}>
          {S.home.saveEvent}
        </Button>
        <Button type="button" variant="outline" onClick={done}>
          {S.common.cancel}
        </Button>
      </div>
      <Message actionKey={key} />
    </form>
  );
}

function EventRow({ event }: { event: CalendarEvent }) {
  const { act } = useActions();
  const at = new Date(event.date + "T" + (event.time ?? "00:00"));
  return (
    <li className="home-event" data-testid="home-event" data-key={event.id}>
      <span className="home-event-when">
        {at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
        {event.time && ", " + at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      </span>
      <strong className="home-event-title">{event.title}</strong>
      <Tag tone={event.kind}>{S.tags[event.kind]}</Tag>
      <Button
        variant="ghost"
        size="sm"
        className="home-event-remove"
        aria-label={fmt(S.home.removeEvent, { title: event.title })}
        title={fmt(S.home.removeEvent, { title: event.title })}
        onClick={() => void act("event-remove-" + event.id, () => api("calendar/" + enc(event.id) + "/remove", {}), "")}
      >
        <X aria-hidden="true" />
      </Button>
    </li>
  );
}

function ThisWeek({ data, now }: { data: PageData; now: Date }) {
  const [mode, setMode] = useState("calendar");
  const [picked, setPicked] = useState(isoDay(now));
  const [adding, setAdding] = useState(false);
  const days = weekOf(now);
  const selected = days.some((d) => isoDay(d) === picked) ? picked : isoDay(now);
  const events = data.home.events ?? [];
  const eventsOn = (k: string) => events.filter((e) => e.date === k);
  const tasksOn = (d: Date) => data.home.runs.filter((r) => r.startedAt && dayKey(new Date(r.startedAt)) === dayKey(d));
  const shownDays = mode === "list" ? days : days.filter((d) => isoDay(d) === selected);
  const shownEvents = shownDays.flatMap((d) => eventsOn(isoDay(d)));
  const shownTasks = shownDays.flatMap(tasksOn);
  const weekEvents = days.flatMap((d) => eventsOn(isoDay(d)));
  const weekKinds = new Set(weekEvents.map((event) => event.kind));
  return (
    <Card className="panel week-panel" data-testid="home-week">
      <div className="page-head">
        <div>
          <h2>
            <CalendarDays aria-hidden="true" className="home-h2-icon" />
            {S.home.week}
          </h2>
          <Hint>{S.home.weekHint}</Hint>
        </div>
        <div className="button-row">
          {[
            ["calendar", S.home.calendar],
            ["list", S.home.list],
          ].map(([k, text]) => (
            <Button key={k} variant="outline" data-testid="home-mode" data-key={k} aria-pressed={mode === k} onClick={() => setMode(k)}>
              {text}
            </Button>
          ))}
          <Button data-testid="home-add-event" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            <Plus aria-hidden="true" />
            {S.home.addEvent}
          </Button>
        </div>
      </div>
      {adding && <AddEvent day={selected} done={() => setAdding(false)} />}
      {mode === "calendar" && (
        <div className="week-days">
          {days.map((d) => {
            const k = isoDay(d);
            const dayEvents = eventsOn(k);
            return (
              <button key={k} className="week-day" data-testid="home-day" data-key={k} aria-pressed={selected === k} onClick={() => setPicked(k)}>
                <span>{k === isoDay(now) ? S.home.today : d.toLocaleDateString(undefined, { weekday: "short" })}</span>
                <strong>{d.getDate()}</strong>
                <span className="week-dots" aria-hidden="true">
                  {dayEvents.slice(0, 4).map((e) => (
                    <i key={e.id} className={"week-dot " + TONE[e.kind]} />
                  ))}
                </span>
                <small>{dayEvents.length ? plural(dayEvents.length, S.home.eventOne, S.home.eventMany) : ""}</small>
              </button>
            );
          })}
        </div>
      )}
      {weekKinds.size > 0 && (
        <div className="home-chips">
          {EVENT_KINDS.filter((k) => weekKinds.has(k)).map((k) => (
            <Tag key={k} tone={k}>
              {S.tags[k] + " (" + weekEvents.filter((e) => e.kind === k).length + ")"}
            </Tag>
          ))}
        </div>
      )}
      {shownEvents.length ? (
        <ul className="home-list">
          {shownEvents.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ul>
      ) : (
        <Hint>{mode === "list" ? S.home.noEventsWeek : S.home.noEvents}</Hint>
      )}
      {shownTasks.length > 0 && (
        <div className="home-week-tasks">
          <h3>{S.home.helperTasks}</h3>
          <ul className="home-list">
            {shownTasks.map((r) => (
              <li key={r.runId} className="home-event" data-testid="home-task" data-key={r.runId}>
                <span className="home-event-when">
                  {new Date(r.startedAt!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </span>
                <a className="link home-event-title" href={"#/run/" + enc(r.runId)} title={r.task}>
                  {snippet(r.task, 90)}
                </a>
                {r.area && <Tag tone={r.area}>{S.tags[r.area]}</Tag>}
                <span className="hint">
                  {whoText(r)} · {stateText(r)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function AiAccounts({ data }: { data: PageData }) {
  const accounts = data.accounts.accounts;
  return (
    <Card className="panel" data-testid="home-accounts">
      <div className="page-head">
        <div>
          <h2>{S.home.accountsTitle}</h2>
          <Hint>{S.home.accountsHint}</Hint>
        </div>
        <a className="link hint home-more" href="#/accounts">
          {S.home.manageAccounts}
          <ArrowRight aria-hidden="true" />
        </a>
      </div>
      {accounts.length ? (
        <ul className="home-list">
          {accounts.map((a) => {
            const status = a.status === "signed_in" ? "loggedIn" : a.status === "limit" ? "limit" : "loggedOut";
            return (
              <li key={a.id} className="home-account" data-testid="home-account" data-key={a.id}>
                <span className={"home-icon " + a.kind} aria-hidden="true">
                  <KeyRound />
                </span>
                <div className="home-project-body">
                  <strong>{toolName(a.kind)}</strong>
                  <span className="hint">{a.name}</span>
                </div>
                <div className="home-chips end">
                  <Tag tone="subscription">{S.tags.subscription}</Tag>
                  <Tag tone={status}>{S.tags[status]}</Tag>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <Hint>{S.home.noAccounts}</Hint>
      )}
    </Card>
  );
}

type ApprovalKind = "decision" | "pr" | "review";
function approvals(runs: Run[]): { run: Run; kind: ApprovalKind }[] {
  const out: { run: Run; kind: ApprovalKind }[] = [];
  for (const run of runs) {
    if (run.lane === "inReview") out.push({ run, kind: "pr" });
    else if (run.lane === "needsYou") out.push({ run, kind: run.state === "running" ? "decision" : "review" });
  }
  const rank: Record<ApprovalKind, number> = { decision: 0, pr: 1, review: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

function PendingApproval({ data }: { data: PageData }) {
  const items = approvals(data.home.runs);
  const body = { decision: S.home.decisionBody, pr: S.home.prBody, review: S.home.reviewBody };
  return (
    <Card className="panel" data-testid="home-approvals">
      <div className="page-head">
        <div>
          <h2>
            <ClipboardCheck aria-hidden="true" className="home-h2-icon" />
            {S.home.approvalsTitle}
          </h2>
          <Hint>{S.home.approvalsHint}</Hint>
        </div>
        <a className="link hint home-more" href="#/helpers">
          {S.home.viewAll}
          <ArrowRight aria-hidden="true" />
        </a>
      </div>
      {items.length ? (
        <ul className="home-list">
          {items.slice(0, 6).map(({ run, kind }) => (
            <li key={run.runId}>
              <a className={"home-approval " + kind} href={"#/run/" + enc(run.runId)} data-testid="home-approval" data-key={kind}>
                <div className="home-project-body">
                  <div className="home-project-title">
                    <strong title={run.task}>{snippet(run.task, 70)}</strong>
                    <Tag tone={kind}>{S.tags[kind]}</Tag>
                    {run.area && <Tag tone={run.area}>{S.tags[run.area]}</Tag>}
                  </div>
                  <span className="hint">
                    {fmt(body[kind], { name: whoText(run), state: stateText(run) })} · {run.project}
                  </span>
                </div>
                <ChevronRight aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Hint>{S.home.noApprovals}</Hint>
      )}
    </Card>
  );
}

export function HomePage({ data, newProject }: { data: PageData; newProject: () => void }) {
  const now = new Date();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greeting(now, data.setup.profileName)}</h1>
        </div>
        <Button data-testid="home-new-project" onClick={newProject}>
          <Plus aria-hidden="true" />
          {S.home.newProject}
        </Button>
      </div>
      <div className="home-dash">
        <StartTask data={data} />
        <ThisWeek data={data} now={now} />
        <AiAccounts data={data} />
        <ActiveProjects data={data} />
        <PendingApproval data={data} />
      </div>
    </>
  );
}
