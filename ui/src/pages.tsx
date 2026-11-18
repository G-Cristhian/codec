import { useRef, useState, type ReactNode, type MouseEvent } from "react";
import { Collapsible } from "radix-ui";
import { CheckCircle2, GitBranch, GraduationCap } from "lucide-react";
import { AgentForm, HarnessCard } from "./agents";
import { ProjectList } from "./project-list";
import { ReviewChanges, TestBadge } from "./diff-viewer";
import { ConversationFeed, useConversationTab, type ProjectConversation } from "./conversation-feed";
import { Badge } from "./components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import {
  S,
  api,
  saveConnection,
  revokeConnection,
  type ConnectionId,
  type ProjectConnection,
  enc,
  fmt,
  toolName,
  toolOK,
  toolProblem,
  whoText,
  stateText,
  when,
  memberHref,
  laneHint,
  laneTone,
  limitText,
  sourceText,
  LANES,
  RequestError,
  errorText,
  type PageData,
  type Role,
  type Run,
  type Skill,
  type Team,
  type Account,
} from "./lib/api";
import {
  Activity,
  Button,
  Card,
  Checks,
  Crumbs,
  Details,
  Disclosure,
  AddDialog,
  EmptyState,
  useDialogDone,
  Field,
  Input,
  Label,
  FolderPicker,
  Form,
  Hint,
  Limit,
  Message,
  Notice,
  Picker,
  Remove,
  StatusBadge,
  Submit,
  Table,
  TaskTable,
  Tip,
  ToolPicker,
  formValue,
  limitValue,
  selected,
  useActions,
  type Option,
  type Confirmation,
} from "./shared";
export const go = (route: string) => {
  location.hash = route;
};
function MessageLimitSettings({ scope, name, limit }: { scope: "project" | "team"; name: string; limit?: number }) {
  // Keep the draft local: dashboard polls must not replace edits or focus.
  const [value, setValue] = useState(limit === undefined ? "" : String(limit));
  const { act, pending } = useActions();
  const key = "message-limit-" + scope + "-" + name;
  const route = (scope === "project" ? "projects/" : "teams/") + enc(name) + "/message-limit";
  async function resetDefault() {
    const draft = value;
    if (await act(key, () => api(route, {}), S.common.saved)) {
      setValue((current) => current === draft ? "" : current);
    }
  }

  return (
    <Form id={scope + "-message-limit-form"} actionKey={key}
      onSubmit={() => api(route, value === "" ? {} : { messageLimit: Number(value) })}>
      <Field id={scope + "-message-limit"} label={S.messageLimit.label} hint={S.messageLimit.hint}
        type="number" min={1} max={100} step={1} value={value} className="limit"
        onChange={(event) => setValue(event.target.value)} />
      <div className="flex gap-2">
        <Submit id={scope + "-message-limit-save"} actionKey={key}>{S.common.save}</Submit>
        <Button type="button" variant="outline" disabled={!!pending[key]} onClick={resetDefault}>{S.messageLimit.resetDefault}</Button>
      </div>
    </Form>
  );
}

function AccountSettings({
  scope,
  name,
  kind,
  data,
}: {
  scope: string;
  name: string;
  kind?: string;
  data: PageData;
}) {
  return (
    <div className="account-settings">
      {(kind ? [kind] : ["claude", "codex"]).map((t) => (
        <AccountPicker key={t} scope={scope} name={name} kind={t} data={data} />
      ))}
      <Hint>{S.accounts.newTasks}</Hint>
      <a className="link" href="#/accounts">
        {S.accounts.open}
      </a>
    </div>
  );
}
function AccountPicker({
  scope,
  name,
  kind,
  data,
}: {
  scope: string;
  name: string;
  kind: string;
  data: PageData;
}) {
  const { act, pending } = useActions();
  const key = scope + "-account-" + name + "-" + kind;
  const [value, setValue] = useState(
    data.accounts.choices[scope + ":" + name]?.[kind] || "__default",
  );
  return (
    <div>
      <Picker
        id={scope + "-account"}
        itemKey={kind}
        label={S.accounts.label + " · " + toolName(kind)}
        value={value}
        disabled={pending[key]}
        options={[
          { value: "__default", label: S.accounts.useDefault },
          ...data.accounts.accounts
            .filter((a) => a.kind === kind)
            .map((a) => ({ value: a.id, label: a.name })),
        ]}
        onChange={(v) => {
          const old = value;
          setValue(v);
          void act(key, async () => {
            try {
              await api("account-settings", {
                scope,
                name,
                kind,
                accountId: v === "__default" ? "" : v,
              });
            } catch (e) {
              setValue(old);
              throw e;
            }
          });
        }}
      />
      <Message actionKey={key} />
    </div>
  );
}
function ProjectAdd() {
  const [tracking, setTracking] = useState<{
    body: { name?: string; path: string };
    question: string;
    checkpoint: boolean;
  }>();
  const { act, pending, tell } = useActions();
  const done = useDialogDone();
  const key = "project-add";
  async function addProject(f: HTMLFormElement) {
    const body = {
      name: formValue(f, "project-name").trim() || undefined,
      path: formValue(f, "project-path").trim(),
    };
    try {
      await api("projects", body);
      setTracking(undefined);
      f.reset();
      tell(key, S.common.added, true);
    } catch (e) {
      const error = e as RequestError;
      if (
        !["needs_tracking", "needs_checkpoint"].includes(error.code || "")
      )
        throw e;
      setTracking({
        body,
        question: errorText(e),
        checkpoint: error.code === "needs_checkpoint",
      });
      return false;
    }
  }

  function confirmTracking(e: MouseEvent<HTMLButtonElement>) {
    if (!tracking) return;
    const f = e.currentTarget.closest("form")!;
    void act(
      key,
      async () => {
        await api("projects", {
          ...tracking.body,
          setUpTracking: true,
        });
        setTracking(undefined);
        f.reset();
      },
      S.common.added,
    ).then((ok) => ok && done?.());
  }

  return (
    <Form
      id="project-add-form"
      actionKey={key}
      success=""
      onInput={() => setTracking(undefined)}
      onSubmit={addProject}
    >
      <Field
        id="project-name"
        label={S.wording.projectName}
        hint={S.projects.nameHint}
      />
      <Hint>{S.wording.nameRules}</Hint>
      <FolderPicker prefix="project" label={S.projects.path} />
      <Submit id="project-save" actionKey={key}>
        {S.projects.add}
      </Submit>
      {tracking && (
        <Notice id="project-tracking">
          <p>{tracking.question}</p>
          <div className="button-row">
            <Button
              type="button"
              data-testid="tracking-yes"
              disabled={pending[key]}
              onClick={confirmTracking}
            >
              {tracking.checkpoint
                ? S.wording.checkpointYes
                : S.wording.trackingYes}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="tracking-no"
              onClick={() => setTracking(undefined)}
            >
              {S.common.cancel}
            </Button>
          </div>
        </Notice>
      )}
    </Form>
  );
}
export function ProjectsPage({
  data,
  openAdd = false,
}: {
  data: PageData;
  openAdd?: boolean;
}) {
  return (
    <div className="project-split index">
      <ProjectList projects={data.home.projects} />
      <section className="page-content">
        <PageIntro title={S.projects.title}>
          <AddDialog
            id="project-add-open"
            label={S.projects.addTitle}
            title={S.projects.addTitle}
            initial={openAdd}
          >
            <ProjectAdd />
          </AddDialog>
        </PageIntro>
        {data.home.projects.length ? (
          <Hint>{S.projects.pick}</Hint>
        ) : (
          <EmptyState id="projects-empty">{S.projects.emptyAdd}</EmptyState>
        )}
        <section>
          <h2>{S.wording.allTasks}</h2>
          <TaskTable runs={data.home.runs} />
        </section>
      </section>
    </div>
  );
}

export function PageIntro({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <div className="description">{description}</div>}
      </div>
      {children}
    </div>
  );
}
function TaskForm({ data, name }: { data: PageData; name: string }) {
  const v = data.project!;
  const key = "project-" + name;
  const options: Option[] = [
    ...v.members.map((m) => ({
      value: "m:" + m.ref,
      tool: m.tool,
      label: m.label,
      group: S.tasks.teamMembers,
    })),
    ...["claude", "codex"].map((t) => ({
      value: "a:" + t,
      tool: t,
      label: fmt(S.wording.quickUsing, { tool: toolName(t) }),
      group: S.tasks.worker,
    })),
  ];
  const [who, setWho] = useState(
    options.find((o) => toolOK(data.setup, o.tool!))?.value || "",
  );
  async function startTask(f: HTMLFormElement) {
    if (!who)
      throw Object.assign(new RequestError(S.errors.missing_tool), {
        code: "missing_tool",
      });
    const r = await api<{ runId: string }>(
      "projects/" + enc(name) + "/runs",
      {
        task: formValue(f, "task-text"),
        timeLimitMinutes: limitValue(f, "task-limit"),
        ...(who.startsWith("m:")
          ? { member: who.slice(2) }
          : { agent: who.slice(2) }),
      },
    );
    f.reset();
    go("#/run/" + enc(r.runId));
  }

  return (
    <Form
      id="task-form"
      actionKey={key}
      success=""
      onSubmit={startTask}
    >
      <Picker
        id="task-who"
        label={S.tasks.who}
        options={options}
        value={who}
        onChange={setWho}
        setup={data.setup}
        required
      />
      <Field
        id="task-text"
        label={S.tasks.task}
        multiline
        required
        placeholder={S.tasks.prompt}
      />
      <Limit id="task-limit" hint={S.wording.usualLimit} />
      <Submit id="task-start" actionKey={key}>
        {S.tasks.start}
      </Submit>
    </Form>
  );
}
function ConnectionForm({ project, id, actionKey, close, showError }: {
  project: string; id: ConnectionId; actionKey: string; close: () => void; showError: (error: string) => void;
}) {
  const [token, setToken] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const { act, pending } = useActions();
  const fieldId = "connection-" + id;
  async function submit() {
    showError("");
    const fields = id === "canvas" ? { instanceUrl: instanceUrl.trim(), token: token.trim() } : { token: token.trim() };
    // Clear on every submission, including client validation and failed requests.
    setToken("");
    if (!fields.token) return showError(S.connections.tokenRequired);
    if (id === "canvas") {
      let url: URL | undefined;
      try { url = new URL(instanceUrl.trim()); } catch { /* Show the inline hint below. */ }
      if (!url || url.protocol !== "https:" || !url.hostname) return showError(S.connections.httpsRequired);
    }
    await act(actionKey, async () => {
      try {
        await saveConnection(project, id, fields);
        close();
      } catch (error) { showError(errorText(error)); }
    }, "");
  }
  return (
    <form className="form" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {id === "canvas" && <div className="field">
        <Label htmlFor={fieldId + "-url"}>{S.connections.instanceUrl}</Label>
        <Input id={fieldId + "-url"} type="url" value={instanceUrl} disabled={!!pending[actionKey]}
          aria-describedby={fieldId + "-url-hint"} onChange={(event) => setInstanceUrl(event.target.value)} />
        <p id={fieldId + "-url-hint"} className="hint">{S.connections.instanceUrlHint}</p>
      </div>}
      <div className="field">
        <Label htmlFor={fieldId + "-token"}>{S.connections.token}</Label>
        <Input id={fieldId + "-token"} type="password" autoComplete="off" value={token} disabled={!!pending[actionKey]}
          aria-describedby={fieldId + "-token-hint"} onChange={(event) => setToken(event.target.value)} />
        <p id={fieldId + "-token-hint"} className="hint">{S.connections[id].tokenHint}</p>
      </div>
      <div className="button-row">
        <Submit id={fieldId + "-save"} actionKey={actionKey}>{S.connections.save}</Submit>
        <Button type="button" variant="outline" disabled={!!pending[actionKey]} onClick={close}>{S.connections.cancel}</Button>
      </div>
    </form>
  );
}

function ConnectionCard({ project, connection, open, changeOpen }: {
  project: string; connection: ProjectConnection; open: boolean; changeOpen: (open: boolean) => void;
}) {
  const { id, connected } = connection;
  const text = S.connections[id];
  const Icon = id === "github" ? GitBranch : GraduationCap;
  const [error, setError] = useState("");
  const { act, confirm, pending } = useActions();
  const actionKey = "connection-" + project + "-" + id;
  function close() { changeOpen(false); setError(""); }
  function revoke() {
    confirm({
      title: fmt(S.connections.revokeTitle, { name: text.name }),
      effects: [{ what: S.connections.revokeEffect, kind: "lost" }],
      label: S.connections.revoke,
      action: async () => {
        setError("");
        await act(actionKey, async () => {
          try { await revokeConnection(project, id); }
          catch (error) { setError(errorText(error)); }
        }, "");
      },
    });
  }
  return (
    <Card className="panel" data-testid={"connection-" + id}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Icon size={20} className="shrink-0" aria-hidden="true" />
          <div><span className="font-semibold">{text.name}</span><Hint>{text.description}</Hint></div>
        </div>
        {connected ? <div className="flex items-center gap-2">
          <CheckCircle2 size={16} className="text-green-600 dark:text-green-400" aria-hidden="true" />
          <span>{S.connections.connected}</span>
          <Button variant="ghost" size="sm" disabled={!!pending[actionKey]} onClick={revoke}>{S.connections.revoke}</Button>
        </div> : <Button variant="outline" size="sm" aria-expanded={open} aria-controls={"connection-" + id + "-content"}
          onClick={() => { setError(""); changeOpen(true); }}>{S.connections.connect}</Button>}
      </div>
      <Collapsible.Root open={open && !connected} onOpenChange={changeOpen}>
        <Collapsible.Content id={"connection-" + id + "-content"}>
          <hr className="my-4" />
          {open && !connected && <ConnectionForm project={project} id={id} actionKey={actionKey} close={close} showError={setError} />}
        </Collapsible.Content>
      </Collapsible.Root>
      {error && <p className="error" role="alert">{error}</p>}
    </Card>
  );
}

function ProjectConnections({ project, connections }: { project: string; connections: ProjectConnection[] }) {
  const [open, setOpen] = useState<ConnectionId>();
  return (
    <Disclosure id="project-connections" title={S.connections.title}>
      <Hint>{S.connections.hint}</Hint>
      {connections.map((connection) => <ConnectionCard key={connection.id} project={project} connection={connection}
        open={open === connection.id} changeOpen={(value) => setOpen((current) => value ? connection.id : current === connection.id ? undefined : current)} />)}
    </Disclosure>
  );
}

export function ProjectPage({ data, name }: { data: PageData; name: string }) {
  const v: NonNullable<PageData["project"]> & Partial<ProjectConversation> = data.project!;
  const [reviewId, setReviewId] = useState<string>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewTrigger = useRef<HTMLButtonElement | null>(null);
  const reviewRun = Object.values(v.lanes).flat().find((run) => run.runId === reviewId);

  const { tab, changeTab, unread } = useConversationTab(v.messagesError ? undefined : v.messages);
  const [compose, setCompose] = useState(
    !LANES.some(([lane]) => v.lanes[lane].length),
  );
  function composeTask() {
    changeTab("board");
    setCompose(true);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(
          '[data-testid="task-text"]',
        )
        ?.focus(),
    );
  }

  return (
    <div className="project-split">
      <ProjectList projects={data.home.projects} active={name} />
      <section className="page-content">
        <Crumbs>{name}</Crumbs>
        <PageIntro
          title={name}
          description={<Hint><span className="mono">{v.project.path}</span></Hint>}
        >
          <Button
            data-testid="task-new"
            onClick={composeTask}
          >
            {S.projects.newTask}
          </Button>
          <Remove
            kind="project"
            name={name}
            route={"projects/" + enc(name) + "/remove"}
            actionKey={"project-" + name}
            after={() => go("#/projects")}
          >
            {S.projects.remove}
          </Remove>
        </PageIntro>
        <Message actionKey={"project-" + name} />
        {reviewRun && <ReviewChanges key={reviewRun.runId} run={reviewRun} actionKey={"project-" + name}
          controlledOpen={reviewOpen} onOpenChange={setReviewOpen} returnFocus={() => reviewTrigger.current?.focus()} />}
        <Disclosure id="project-account-settings" title={S.messageLimit.settings}>
          <Card className="panel">
            <MessageLimitSettings key={name} scope="project" name={name} limit={v.project.messageLimit} />
            <AccountSettings data={data} scope="project" name={name} />
          </Card>
        </Disclosure>
        <ProjectConnections key={name} project={name} connections={v.connections} />
        <Tabs value={tab} onValueChange={changeTab}>
          <TabsList>
            <TabsTrigger value="board">{S.conversation.board}</TabsTrigger>
            <TabsTrigger value="conversation">
              {S.conversation.title}
              {unread > 0 && <Badge variant="secondary" aria-label={fmt(S.conversation.unread, { count: unread })}>{unread}</Badge>}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="board" className="space-y-6">
            <Collapsible.Root open={compose} onOpenChange={setCompose}>
              <Collapsible.Trigger asChild>
                <Button variant="outline" data-testid="task-new-open">
                  {S.wording.giveTask}
                </Button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <Card className="panel">
                  <h2>{S.wording.giveTask}</h2>
                  <Hint>{S.wording.helperIntro}</Hint>
                  {!v.members.length && (
                    <Notice>
                      {S.projects.noTeam}
                      <a className="link font-semibold" href="#/teams">
                        {S.members.addTeam}
                      </a>
                      {S.projects.noTeamAfter}
                    </Notice>
                  )}
                  <TaskForm data={data} name={name} />
                </Card>
              </Collapsible.Content>
            </Collapsible.Root>
            <section>
              <h2>{S.projects.board}</h2>
              <Hint>{S.wording.workspace}</Hint>
              <div className="board">
                {LANES.map(([lane, text]) => (
                  <section key={lane} className="lane">
                    <div className="button-row justify-between">
                      <h3>
                        <StatusBadge
                          text={text}
                          tone={laneTone(lane)}
                        />
                      </h3>
                      <span className="badge">{v.lanes[lane].length}</span>
                    </div>
                    <Hint>{laneHint(lane)}</Hint>
                    <div className="lane-tasks">
                      {v.lanes[lane].length ? (
                        v.lanes[lane].map((r) => (
                          <div key={r.runId} className="space-y-2">
                            <a
                              className="card-link"
                              href={"#/run/" + enc(r.runId)}
                              data-testid="task-open"
                              data-key={r.runId}
                            >
                              <Card className="task-card">
                                <strong>{whoText(r)}</strong>
                                <p className="line-clamp-3">{r.task}</p>
                                {r.specialist && (
                                  <Hint>
                                    {fmt(S.wording.teamRole, {
                                      team: r.team,
                                      role: r.specialist,
                                    })}
                                  </Hint>
                                )}
                                <StatusBadge run={r} />
                                <TestBadge run={r} />
                                <Hint>{when(r.startedAt)}</Hint>
                              </Card>
                            </a>
                            {(lane === "inReview" || lane === "done" || r.reviewed?.action === "applied") &&
                              (r.reviewStatus === "ready" || r.reviewStatus === "no_changes" || r.reviewed?.action === "applied" && r.reviewed.tests) &&
                              <Button variant="outline" size="sm" data-testid="task-review" ref={(node) => { if (r.runId === reviewId) reviewTrigger.current = node; }} onClick={(event) => { reviewTrigger.current = event.currentTarget; setReviewId(r.runId); setReviewOpen(true); }}>{S.diffViewer.button}</Button>}
                          </div>
                        ))
                      ) : (
                        <Hint>{S.common.empty}</Hint>
                      )}
                    </div>
                  </section>
                ))}
              </div>
            </section>
          </TabsContent>
          <TabsContent value="conversation" forceMount hidden={tab !== "conversation"} className="h-[min(36rem,70dvh)] min-h-80 flex-none data-[state=inactive]:hidden">
            <ConversationFeed name={name} messages={v.messages} helpers={v.helpers} messagesError={v.messagesError} cappedPairs={v.cappedPairs} active={tab === "conversation"} />
          </TabsContent>
        </Tabs>
      </section>
      <aside className="page-content project-detail">
        <Card className="panel">
          <h2>{S.projects.team}</h2>
          {v.members.length ? (
            v.members.map((m) => (
              <div key={m.ref}>
                <a className="link" href={m.team ? memberHref(m.team, m.member) : "#/helpers"}>
                  {m.ref === "coordinator" ? S.coordinator.name : m.member}
                </a>
                {" · "}
                {m.ref === "coordinator" ? S.coordinator.explanation : m.specialty || S.members.worker}
                <Hint>
                  {whoText(m)}
                  {" · "}
                  {toolName(m.tool)}
                </Hint>
              </div>
            ))
          ) : (
            <Hint>{S.projects.noHelpers}</Hint>
          )}
        </Card>
        <Card className="panel">
          <h2>{S.projects.path}</h2>
          <p className="mono">{v.project.path}</p>
          <Hint>{S.wording.workspace}</Hint>
        </Card>
      </aside>
    </div>
  );
}
function unusedSkillsText(run: Run) {
  if (run.agent === "codex") return S.tasks.codexSkills;
  if (run.state === "running") return S.tasks.noUsed;
  return S.wording.noSkillUse;
}

export function TaskPage({ data }: { data: PageData }) {
  const r = data.run!;
  const { confirm } = useActions();
  const key = "task-" + r.runId;
  function clean(force = false, deleteBranch = false) {
    const dialog: Confirmation = {
      title: force ? S.tasks.forceTitle : S.tasks.cleanTitle,
      effects: [
        {
          what: force ? S.tasks.forceEffect : S.tasks.cleanEffect,
          kind: "lost",
        },
        { what: S.wording.deleteSavedEffect, kind: "lost" },
      ],
      clean: true,
      deleteBranch,
      label: S.tasks.clean,
      action: async (removeBranch) => {
        try {
          await api("runs/" + enc(r.runId) + "/clean", {
            force,
            deleteBranch: removeBranch,
          });
        } catch (e) {
          if (!force && (e as RequestError).code === "uncommitted_changes") {
            setTimeout(() => clean(true, removeBranch), 0);
          }
          throw e;
        }
      },
    };
    confirm(dialog);
  }
  return (
    <>
      <Crumbs>
        <a href={"#/project/" + enc(r.project)}>{r.project}</a> / {S.tasks.task}
      </Crumbs>
      <PageIntro
        title={
          <>
            {S.tasks.details} <StatusBadge run={r} />
            <TestBadge run={r} />
          </>
        }
      >
        {r.state === "running" ? (
          <Button
            variant="destructive"
            data-testid="task-stop"
            onClick={() =>
              confirm({
                title: S.tasks.stopTitle,
                effects: [{ what: S.tasks.stopEffect, kind: "kept" }],
                label: S.tasks.stop,
                action: () => api("runs/" + enc(r.runId) + "/stop", {}),
              })
            }
          >
            {S.tasks.stop}
          </Button>
        ) : (
          !r.cleanedAt && (
            <Button
              variant="outline"
              data-testid="task-clean"
              onClick={() => clean()}
            >
              {S.tasks.clean}
            </Button>
          )
        )}
        <ReviewChanges run={r} actionKey={key} />
      </PageIntro>
      <Message actionKey={key} />
      {r.limitHit && (
        <Notice tone="needs" id="task-account-limit">
          <p>{S.accounts.limitMessage}</p>
          <Button asChild variant="outline" size="sm">
            <a href="#/accounts">{S.accounts.open}</a>
          </Button>
        </Notice>
      )}
      {r.autoSaved && <Notice id="task-auto-saved">{S.tasks.autoSaved}</Notice>}
      {r.checkpointError && (
        <Notice danger id="task-checkpoint-error">
          {S.errors[r.checkpointError]}
        </Notice>
      )}
      {r.reviewStatus === "unsaved" && (
        <Notice tone="needs" id="task-unsaved">
          {S.tasks.unsavedHelp}
        </Notice>
      )}
      {r.reviewStatus === "unavailable" && (
        <Notice tone="needs" id="task-workspace-unchecked">
          {S.tasks.workspaceUncheckedHelp}
        </Notice>
      )}
      <Card className="panel">
        <h2>{S.tasks.task}</h2>
        <p className="fulltask text-base">{r.task}</p>
      </Card>
      <Activity run={r} />
      <Card className="panel">
        <Details
          pairs={[
            [S.tasks.state, stateText(r)],
            [S.tasks.who, whoText(r)],
            [S.common.tool, toolName(r.agent)],
            [S.accounts.label, r.account?.name || S.accounts.computer],
            [
              S.wording.aiModel,
              r.model ||
                (r.actualModel
                  ? fmt(S.common.defaultModelUsed, { model: r.actualModel })
                  : S.common.defaultModel),
            ],
            [S.wording.team, r.team || S.common.none],
            [S.members.kind, r.specialist || S.members.worker],
            [S.tasks.started, when(r.startedAt)],
            [S.tasks.deadline, when(r.deadline)],
            [S.common.timeLimitLabel, limitText(r.timeLimitMinutes)],
          ]}
        />
      </Card>
      <div className="skill-panels">
        <Card className="panel">
          <h2>{S.tasks.skillsGiven}</h2>
          <Hint>{S.wording.skillsIntro}</Hint>
          {r.skillsGiven.length ? (
            <Table
              headers={[S.common.skills, S.tasks.source, S.skills.description]}
            >
              {r.skillsGiven.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{sourceText(s, r.project)}</td>
                  <td>{s.description}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Hint>{S.tasks.noSkills}</Hint>
          )}
        </Card>
        <Card className="panel">
          <h2>{S.tasks.skillsUsed}</h2>
          {r.skillsUsed.length ? (
            <Table headers={[S.common.skills, S.tasks.how, S.tasks.evidence]}>
              {r.skillsUsed.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>
                    <StatusBadge
                      text={
                        s.how === "guess" ? S.tasks.guess : S.tasks.detected
                      }
                      tone={s.how === "guess" ? "needs" : "done"}
                    />
                  </td>
                  <td>{s.evidence}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Hint>{unusedSkillsText(r)}</Hint>
          )}
        </Card>
      </div>
      <Disclosure id="task-technical" title={S.wording.technical}>
        <Card className="panel">
          <Details
            mono
            pairs={[
              [S.wording.taskNumber, r.runId],
              [S.tasks.branch, r.branch],
              [S.tasks.folder, r.cleanedAt ? S.tasks.cleaned : r.worktree],
            ]}
          />
        </Card>
      </Disclosure>
    </>
  );
}
function RoleForm({ role, data }: { role?: Role; data: PageData }) {
  const key = role ? "specialist-edit-" + role.name : "specialist-add";
  async function saveRole(f: HTMLFormElement) {
    await api(
      role ? "specialists/" + enc(role.name) + "/edit" : "specialists",
      {
        name: role ? undefined : formValue(f, "specialist-name").trim(),
        specialty: formValue(f, "specialist-specialty").trim(),
        tool: formValue(f, "specialist-tool"),
        model: formValue(f, "specialist-model").trim(),
        instructions: formValue(f, "specialist-instructions"),
        skills: selected(f, "specialist-skill"),
        timeLimitMinutes: limitValue(f, "specialist-limit"),
      },
    );
    if (!role) f.reset();
  }

  return (
    <Form
      id={role ? "specialist-edit-form" : "specialist-add-form"}
      itemKey={role?.name}
      actionKey={key}
      success={role ? S.common.saved : S.common.added}
      onSubmit={saveRole}
    >
      {!role && (
        <Field
          id="specialist-name"
          label={S.common.name}
          required
          placeholder={S.wording.roleName}
          hint={S.wording.nameRules}
        />
      )}
      <Field
        id="specialist-specialty"
        label={S.specialists.specialty}
        required
        defaultValue={role?.specialty}
        placeholder={S.specialists.specialtyHint}
      />
      <ToolPicker
        id="specialist-tool"
        setup={data.setup}
        initial={role?.tool}
      />
      <Field
        id="specialist-model"
        label={S.common.model}
        defaultValue={role?.model}
      />
      <Limit id="specialist-limit" value={role?.timeLimitMinutes} />
      <Field
        id="specialist-instructions"
        label={S.common.instructions}
        multiline
        defaultValue={role?.instructions}
        hint={S.common.instructionsHint}
      />
      <Checks
        id="specialist-skill"
        names={data.skills!.skills.map((s) => s.name)}
        values={role?.skills}
        label={S.specialists.skills}
        skills
      />
      <Submit id="specialist-save" actionKey={key}>
        {role ? S.wording.saveChanges : S.specialists.add}
      </Submit>
    </Form>
  );
}
export function RolesPage({ data }: { data: PageData }) {
  const roles = data.roles!;
  return (
    <>
      <Crumbs>{S.nav.specialists}</Crumbs>
      <PageIntro title={S.specialists.title}>
        <AddDialog
          id="specialist-add-open"
          label={S.specialists.addTitle}
          title={S.specialists.addTitle}
        >
          <RoleForm data={data} />
        </AddDialog>
      </PageIntro>
      {!roles.length && (
        <EmptyState id="roles-empty">{S.specialists.emptyAdd}</EmptyState>
      )}
      {roles.map((s) => (
        <RoleCard key={s.name} s={s} data={data} />
      ))}
    </>
  );
}
function RoleCard({ s, data }: { s: Role; data: PageData }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} asChild>
      <Card className="panel" data-key={s.name}>
        <div className="page-head">
          <div>
            <h3>{s.name}</h3>
            <Hint>
              {s.specialty} · {toolName(s.tool)}
              {s.model && " · " + S.wording.aiModel + " " + s.model}
            </Hint>
          </div>
          <div className="button-row">
            <Collapsible.Trigger asChild>
              <Button
                variant="outline"
                data-testid="specialist-edit-open"
                data-key={s.name}
              >
                {S.specialists.edit}
              </Button>
            </Collapsible.Trigger>
            <Remove
              kind="specialist"
              name={s.name}
              route={"specialists/" + enc(s.name) + "/remove"}
              actionKey={"specialist-" + s.name}
            >
              {S.specialists.remove}
            </Remove>
          </div>
        </div>
        <Details
          pairs={[
            [S.common.timeLimitLabel, limitText(s.timeLimitMinutes ?? 60)],
            [
              S.common.skills,
              <span className="badge-row">
                {s.skills.length
                  ? s.skills.map((n) => (
                      <span className="badge" key={n}>
                        {n}
                      </span>
                    ))
                  : S.common.none}
              </span>,
            ],
            [
              S.common.instructions,
              <p className={open ? "fulltask" : "fulltask line-clamp-4"}>
                {s.instructions || S.common.none}
              </p>,
            ],
          ]}
        />
        <p>
          {S.specialists.copies}:{" "}
          {s.clones.length ? (
            s.clones.map((c, i) => (
              <span key={c.team + "/" + c.member}>
                {i ? ", " : ""}
                <a className="link" href={memberHref(c.team, c.member)}>
                  {fmt(S.wording.helperTeam, c)}
                </a>
              </span>
            ))
          ) : (
            <span className="hint">{S.wording.noRoleUsers}</span>
          )}
        </p>
        <Message actionKey={"specialist-" + s.name} />
        <Collapsible.Content className="disclosure-content">
          <RoleForm role={s} data={data} />
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>
  );
}

export function TeamForm({ team, data }: { team?: Team; data: PageData }) {
  const key = team ? "team-edit-" + team.name : "team-add";
  async function saveTeam(f: HTMLFormElement) {
    await api(team ? "teams/" + enc(team.name) + "/projects" : "teams", {
      name: team ? undefined : formValue(f, "team-name").trim(),
      projects: selected(f, "team-project"),
    });
    if (!team) f.reset();
  }

  return (
    <>
      <Form
        id={team ? "team-edit-form" : "team-add-form"}
        itemKey={team?.name}
        actionKey={key}
        success={team ? S.common.saved : S.common.added}
        onSubmit={saveTeam}
      >
        {!team && (
          <Field
            id="team-name"
            label={S.common.name}
            required
            placeholder={S.wording.teamName}
            hint={S.wording.nameRules}
          />
        )}
        {data.home.projects.length ? (
          <Checks
            id="team-project"
            names={data.home.projects.map((p) => p.name)}
            values={team?.projects}
            label={S.teams.projects}
          />
        ) : (
          <Hint>{S.agents.noProjects}</Hint>
        )}
        <Submit id="team-save" actionKey={key}>
          {team ? S.common.save : S.teams.add}
        </Submit>
      </Form>
      {team && (
        <>
          <hr />
          <MessageLimitSettings key={team.name} scope="team" name={team.name} limit={team.messageLimit} />
          <AccountSettings scope="team" name={team.name} data={data} />
        </>
      )}
    </>
  );
}
export function MemberPage({
  data,
  team,
  name,
}: {
  data: PageData;
  team: string;
  name: string;
}) {
  const m = data.member!;
  const finished = m.runs.filter((r) => r.state !== "running");
  return (
    <>
      <Crumbs>
        <a href="#/teams">{S.nav.teams}</a> / {team} / {name}
      </Crumbs>
      <PageIntro
        title={fmt(S.wording.helperTeam, { team, member: name })}
      >
        <div className="button-row">
          <Remove
            kind="member"
            name={team + "/" + name}
            route={"teams/" + enc(team) + "/members/" + enc(name) + "/remove"}
            actionKey={"member-" + team + "-" + name}
            after={() => go("#/teams")}
          >
            {S.members.remove}
          </Remove>
          <AddDialog id="member-edit-open" label={S.agents.edit} title={S.agents.edit + " · " + name} wide plus={false}>
            <AgentForm team={team} data={data} member={{ ...m, member: name }} />
          </AddDialog>
        </div>
      </PageIntro>
      <Card className="panel">
        <Details
          pairs={[
            [
              S.members.title,
              fmt(S.wording.helperTeam, { team, member: name }),
            ],
            [
              m.specialist ? S.members.kind : S.agents.job,
              m.specialist
                ? fmt(S.wording.usesRole, {
                    name: m.specialist,
                    specialty: m.specialty,
                  })
                : m.specialty || S.members.worker,
            ],
            [S.common.tool, toolName(m.tool)],
            [S.common.timeLimitLabel, limitText(m.timeLimitMinutes ?? 60)],
            [
              S.nav.projects,
              m.projects.map((p, i) => (
                <span key={p}>
                  {i ? ", " : ""}
                  <a className="link" href={"#/project/" + enc(p)}>
                    {p}
                  </a>
                </span>
              )),
            ],
          ]}
        />
      </Card>
      <Card className="panel">
        <h2>{S.common.instructions}</h2>
        <p className="fulltask">{m.instructions || S.common.none}</p>
        <Hint>{S.agents.instructionsHint}</Hint>
      </Card>
      <HarnessCard m={m} />
      <Message actionKey={"member-" + team + "-" + name} />
      <Disclosure id="member-account-open" title={S.accounts.title}>
        <Card className="panel">
          <AccountSettings
            scope="helper"
            name={team + "/" + name}
            kind={m.tool}
            data={data}
          />
        </Card>
      </Disclosure>
      <section>
        <h2>{S.common.skills}</h2>
        <Hint>{S.wording.skillsIntro}</Hint>
        {m.skills.length ? (
          <Table headers={[S.common.skills, S.tasks.source]}>
            {m.skills.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td>{sourceText(s)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Hint>{S.wording.noSkills}</Hint>
        )}
      </section>
      <section>
        <h2>{S.members.working}</h2>
        {m.working.length ? (
          <TaskTable runs={m.working} member />
        ) : (
          <Hint>{S.wording.nothingNow}</Hint>
        )}
      </section>
      <section>
        <h2>{S.members.past}</h2>
        {finished.length ? (
          <TaskTable
            runs={finished}
            member
          />
        ) : (
          <Hint>{S.wording.noFinished}</Hint>
        )}
      </section>
    </>
  );
}
function readB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new RequestError(S.skills.uploadError));
    reader.readAsDataURL(file);
  });
}
function SkillAdd() {
  const [folder, setFolder] = useState("");
  async function addFromPath(f: HTMLFormElement) {
    await api("skills", {
      path: formValue(f, "skill-path").trim(),
      name: f.dataset.skillName,
    });
    delete f.dataset.skillName;
    f.reset();
  }

  async function uploadSkill(f: HTMLFormElement) {
    const input = f.querySelector<HTMLInputElement>("[type=file]")!;
    if (!input.files?.length)
      throw new RequestError(S.skills.uploadRequired);
    const files = await Promise.all(
      [...input.files].map(async (file) => ({
        path: file.webkitRelativePath || file.name,
        content: await readB64(file),
      })),
    );
    await api("skills", { files, name: f.dataset.skillName });
    delete f.dataset.skillName;
    f.reset();
    setFolder("");
  }

  return (
    <Tabs defaultValue="path">
      <TabsList>
        <TabsTrigger value="path">{S.skills.path}</TabsTrigger>
        <TabsTrigger value="upload">{S.skills.upload}</TabsTrigger>
      </TabsList>
      <TabsContent value="path">
        <Form
          id="skill-add-form"
          actionKey="skill-add"
          success={S.common.added}
          onSubmit={addFromPath}
        >
          <FolderPicker prefix="skill" label={S.skills.path} />
          <Hint>{S.skills.hint}</Hint>
          <Submit id="skill-save" actionKey="skill-add">
            {S.skills.add}
          </Submit>
        </Form>
      </TabsContent>
      <TabsContent value="upload">
        <Form
          id="skill-upload-form"
          actionKey="skill-upload"
          success={S.common.added}
          onSubmit={uploadSkill}
        >
          <Hint>{S.skills.uploadHint}</Hint>
          <Field
            id="skill-upload"
            label={S.skills.upload}
            type="file"
            {...({ webkitdirectory: "" } as object)}
            multiple
            required
            onChange={(e) =>
              setFolder(
                e.target.files?.[0]?.webkitRelativePath.split("/")[0] || "",
              )
            }
          />
          {folder && <p>{folder}</p>}
          <Submit id="skill-upload-save" actionKey="skill-upload">
            {S.skills.uploadSave}
          </Submit>
        </Form>
      </TabsContent>
    </Tabs>
  );
}
function skillHolders(skill: Skill) {
  const specialists = (skill.specialists || []).map((name) => fmt(S.members.copyOf, { name }));
  const members = (skill.members || []).map((ref) => {
    const [team, member] = ref.split("/");
    return fmt(S.wording.helperTeam, { team, member });
  });
  return [...specialists, ...members].join(", ") || S.wording.noHolders;
}

function skillMarker(source: string) {
  const own = source === "own";
  const text = own ? S.skills.own : S.skills.inherited;
  return (
    <Tip text={text}>
      <span className={own ? "success" : "role-dot"} tabIndex={0} aria-label={text}>
        {own ? "●" : "○"}
      </span>
    </Tip>
  );
}

export function SkillsPage({ data }: { data: PageData }) {
  const v = data.skills!;
  return (
    <>
      <Crumbs>{S.nav.skills}</Crumbs>
      <PageIntro title={S.skills.title}>
        <AddDialog
          id="skill-add-open"
          label={S.skills.addTitle}
          title={S.skills.addTitle}
        >
          <SkillAdd />
        </AddDialog>
      </PageIntro>
      <section>
        <h2>{S.skills.library}</h2>
        {v.skills.length ? (
          <Table
            headers={[
              S.common.skills,
              S.skills.description,
              S.skills.holders,
              "",
            ]}
          >
            {v.skills.map((s) => (
              <tr key={s.name}>
                <td className="font-semibold">{s.name}</td>
                <td>{s.description}</td>
                <td>
                  {skillHolders(s)}
                </td>
                <td>
                  <Remove
                    kind="skill"
                    name={s.name}
                    route={"skills/" + enc(s.name) + "/remove"}
                    actionKey={"skill-" + s.name}
                  >
                    {S.skills.remove}
                  </Remove>
                  <Message actionKey={"skill-" + s.name} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Hint>{S.skills.empty}</Hint>
        )}
      </section>
      <section>
        <h2>{S.skills.grid}</h2>
        <Hint>{S.skills.gridHint}</Hint>
        {v.grid.rows.length && v.grid.skills.length ? (
          <Table
            className="skills-grid"
            headers={[S.members.title, S.common.tool, ...v.grid.skills]}
          >
            {v.grid.rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.kind === "member" ? (
                    <a
                      className="link"
                      href={memberHref(r.id.split("/")[0], r.id.split("/")[1])}
                    >
                      {r.label}
                    </a>
                  ) : (
                    r.label
                  )}
                </td>
                <td>{toolName(r.tool)}</td>
                {v.grid.skills.map((name) => (
                  <td key={name}>
                    {r.skills[name] && skillMarker(r.skills[name])}
                  </td>
                ))}
              </tr>
            ))}
          </Table>
        ) : (
          <Hint>{S.wording.skillGridEmpty}</Hint>
        )}
      </section>
    </>
  );
}
function LoginDetails({ account }: { account: Account }) {
  const { act, pending } = useActions();
  const login = account.login,
    key = "account-" + account.id;
  if (!login) return null;
  if (login.state !== "waiting")
    return (
      <p
        data-testid="account-login-state"
        className={
          login.state === "signed_in"
            ? "success"
            : login.state === "canceled"
              ? "hint"
              : "warning"
        }
      >
        {login.state === "signed_in"
          ? S.accounts.signedIn
          : S.accounts[login.state as "canceled" | "timed_out" | "failed"]}
      </p>
    );
  return (
    <Notice id="account-login">
      <ol className="login-steps">
        <li>{S.accounts.waiting}</li>
        {login.url && (
          <li>
            <Button asChild>
              <a
                href={login.url}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                data-testid="account-open-sign-in"
              >
                {S.accounts.openSignIn}
              </a>
            </Button>
          </li>
        )}
        {login.code && (
          <li>
            <p>{S.accounts.deviceCode}</p>
            <strong className="device-code" data-testid="account-device-code">
              {login.code}
            </strong>
          </li>
        )}
        {login.needsCode && (
          <li>
            <Form
              id="account-code-form"
              actionKey={key}
              success=""
              onSubmit={async (f) => {
                const code = formValue(f, "account-code-" + account.id).trim();
                f.reset();
                await api("accounts/" + enc(account.id) + "/code", { code });
              }}
            >
              <Hint>{S.accounts.pasteHint}</Hint>
              <Field
                id={"account-code-" + account.id}
                label={S.accounts.pasteCode}
                type="password"
                autoComplete="off"
              />
              <Submit id="account-send-code" actionKey={key}>
                {S.accounts.sendCode}
              </Submit>
            </Form>
          </li>
        )}
      </ol>
      <Button
        type="button"
        variant="outline"
        data-testid="account-cancel"
        disabled={pending[key]}
        onClick={() =>
          void act(
            key,
            () => api("accounts/" + enc(account.id) + "/cancel", {}),
            "",
          )
        }
      >
        {S.common.cancel}
      </Button>
    </Notice>
  );
}
function AccountAdd() {
  const [kind, setKind] = useState("claude");
  const [method, setMethod] = useState("device");
  return (
    <Form
      id="account-add-form"
      actionKey="account-add"
      success=""
      onSubmit={async (f) => {
        const a = await api<Account>("accounts", {
          name: formValue(f, "account-name").trim(),
          kind,
        });
        await api("accounts/" + enc(a.id) + "/login", { method });
        f.reset();
      }}
    >
      <Picker
        id="account-kind"
        label={S.common.tool}
        value={kind}
        onChange={setKind}
        options={["claude", "codex"].map((t) => ({
          value: t,
          label: toolName(t),
        }))}
      />
      <Field
        id="account-name"
        label={S.common.name}
        required
        maxLength={80}
        hint={S.accounts.nameHint}
      />
      {kind === "codex" && (
        <Picker
          id="account-method"
          label={S.accounts.method}
          value={method}
          onChange={setMethod}
          options={[
            { value: "device", label: S.accounts.device },
            { value: "browser", label: S.accounts.browser },
          ]}
        />
      )}
      <Submit id="account-sign-in" actionKey="account-add">
        {S.accounts.signIn}
      </Submit>
    </Form>
  );
}
export function AccountsPage({ data }: { data: PageData }) {
  const { act, pending } = useActions();
  const state = data.accounts;
  return (
    <>
      <Crumbs>{S.nav.accounts}</Crumbs>
      <PageIntro
        title={S.accounts.title}
        description={<Hint>{S.accounts.newTasks}</Hint>}
      >
        <div className="button-row">
          <Button
            variant="outline"
            data-testid="accounts-check"
            disabled={pending.accounts}
            onClick={() =>
              void act("accounts", () => api("accounts?fresh=1"), "")
            }
          >
            {S.accounts.check}
          </Button>
          <AddDialog
            id="account-add-open"
            label={S.accounts.add}
            title={S.accounts.add}
          >
            <AccountAdd />
          </AddDialog>
        </div>
      </PageIntro>
      <Message actionKey="accounts" />
      <div className="account-grid">
        {state.accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            isDefault={state.defaults[account.kind] === account.id}
          />
        ))}
      </div>
    </>
  );
}
function AccountCard({
  account: a,
  isDefault,
}: {
  account: Account;
  isDefault: boolean;
}) {
  const { act, pending, confirm } = useActions();
  const key = "account-" + a.id,
    route = "accounts/" + enc(a.id);
  const disabled = !!a.running || !!pending[key];
  return (
    <Card className="panel" data-testid="account-card" data-key={a.id}>
      <h3>{a.name}</h3>
      <div className="badge-row">
        <span className="badge">{toolName(a.kind)}</span>
        <StatusBadge
          text={
            a.status === "signed_in"
              ? S.accounts.signedIn
              : a.status === "limit"
                ? S.accounts.limit
                : S.accounts.needsSignIn
          }
          tone={
            a.status === "signed_in"
              ? "done"
              : a.status === "limit"
                ? "destructive"
                : "needs"
          }
        />
        {isDefault && (
          <span className="badge default-badge">{S.accounts.default}</span>
        )}
      </div>
      <div className="button-row">
        {!isDefault && (
          <Button
            variant="outline"
            data-testid="account-default"
            disabled={disabled}
            onClick={() => void act(key, () => api(route + "/default", {}))}
          >
            {S.accounts.makeDefault}
          </Button>
        )}
        {!a.builtin && a.login?.state !== "waiting" && (
          <>
            <Tip text={a.running ? S.errors.account_busy : S.accounts.signIn}>
              <span>
                <Button
                  variant={a.status === "signed_in" ? "outline" : "default"}
                  data-testid="account-sign-in-again"
                  disabled={disabled}
                  onClick={() =>
                    void act(
                      key,
                      () => api(route + "/login", { method: "device" }),
                      "",
                    )
                  }
                >
                  {S.accounts.signIn}
                </Button>
              </span>
            </Tip>
            {a.kind === "codex" && (
              <Tip
                text={a.running ? S.errors.account_busy : S.accounts.browser}
              >
                <span>
                  <Button
                    variant="outline"
                    data-testid="account-browser-sign-in"
                    disabled={disabled}
                    onClick={() =>
                      void act(
                        key,
                        () => api(route + "/login", { method: "browser" }),
                        "",
                      )
                    }
                  >
                    {S.accounts.browser}
                  </Button>
                </span>
              </Tip>
            )}
          </>
        )}
        {!a.builtin && (
          <Tip text={a.running ? S.errors.account_busy : S.accounts.remove}>
            <span>
              <Button
                variant="outline"
                className="remove"
                data-testid="account-remove"
                disabled={disabled}
                onClick={() =>
                  confirm({
                    title: fmt(S.accounts.removeTitle, { name: a.name }),
                    effects: [{ what: S.accounts.removeEffect, kind: "lost" }],
                    action: () => api(route + "/remove", { confirmed: true }),
                  })
                }
              >
                {S.accounts.remove}
              </Button>
            </span>
          </Tip>
        )}
      </div>
      <LoginDetails account={a} />
      <Message actionKey={key} />
    </Card>
  );
}
export function SetupPage({ data }: { data: PageData }) {
  const { act, pending } = useActions();
  const setup = data.setup;
  const working = setup.tools.filter((t) => toolOK(setup, t.tool));
  const needed = [
    ...(!setup.ready ? [S.setup.notReady] : []),
    ...(!setup.identityReady ? [S.setup.identityNeeded] : []),
  ];
  const status = needed.length
    ? needed.join(" ")
    : working.length === 1
      ? fmt(S.setup.oneReady, { tool: toolName(working[0].tool) })
      : S.setup.ready;
  function finishSetup() {
    void act("setup", async () => {
      await api("settings", { setupFinished: true });
      go("#/");
    }, "");
  }

  return (
    <section data-testid="setup-wizard" className="setup-page">
      <PageIntro title={S.setup.title} />
      <Notice tone={needed.length ? "needs" : "done"} id="setup-status">
        <span className={needed.length ? "warning" : "success"}>
          {needed.length ? "⚠ " : "✓ "}
          {status}
        </span>
      </Notice>
      <Card className="panel">
        <h2>
          <span className="step-number">1</span>
          {S.common.tool}
        </h2>
        <ToolCards data={data} />
      </Card>
      <Card className="panel">
        <h2>{S.setup.identity}</h2>
        <Hint>{S.setup.identityHint}</Hint>
        <IdentityForm data={data} />
      </Card>
      <Message actionKey="setup" />
      <footer className="setup-footer">
        <Button
          variant="ghost"
          data-testid="setup-skip"
          disabled={pending.setup}
          onClick={finishSetup}
        >
          {S.setup.skip}
        </Button>
        <Button
          variant="outline"
          data-testid="setup-check"
          disabled={pending.setup}
          onClick={() => void act("setup", () => api("setup?fresh=1"), "")}
        >
          {S.setup.check}
        </Button>
        <Button
          data-testid="setup-continue"
          disabled={!setup.ready || pending.setup}
          onClick={finishSetup}
        >
          {S.setup.continue}
        </Button>
      </footer>
    </section>
  );
}

export function IdentityForm({
  data,
  plain = false,
}: {
  data: PageData;
  plain?: boolean;
}) {
  return (
    <>
      {!data.setup.identityReady && (
        <Notice tone="needs" id="identity-missing">
          {S.setup.identityMissing}
        </Notice>
      )}
      <Form
        id="identity-form"
        actionKey="identity"
        onSubmit={async (f) => {
          await api("settings", {
            identity: {
              name: formValue(f, "identity-name"),
              email: formValue(f, "identity-email"),
            },
          });
        }}
      >
        <Field
          id="identity-name"
          label={S.setup.identityName}
          required
          autoComplete="name"
          defaultValue={data.settings!.identity.name}
        />
        <Field
          id="identity-email"
          label={S.setup.identityEmail}
          required
          autoComplete="email"
          type="email"
          defaultValue={data.settings!.identity.email}
        />
        <Submit id="identity-save" actionKey="identity">
          {plain ? S.profile.saveChanges : S.common.save}
        </Submit>
      </Form>
    </>
  );
}
export function ToolCards({
  data,
  okText = S.setup.ok,
}: {
  data: PageData;
  okText?: string;
}) {
  const { tell } = useActions();
  async function copyFix(t: PageData["setup"]["tools"][number]) {
    try {
      await navigator.clipboard.writeText(
        t.fix || S.setup.fixMissing,
      );
      tell("setup-" + t.tool, S.common.copied, true);
    } catch {
      tell("setup-" + t.tool, S.common.copyFailed);
    }
  }

  function renderTool(t: PageData["setup"]["tools"][number]) {
    const ready = toolOK(data.setup, t.tool);
    return (
      <section
        key={t.tool}
        className="setup-tool"
        data-testid="setup-tool"
        data-key={t.tool}
      >
        <div className="button-row">
          <strong>{toolName(t.tool)}</strong>
          <StatusBadge
            text={
              ready
                ? okText
                : toolProblem(data.setup, t.tool)
            }
            tone={ready ? "done" : "needs"}
          />
          {t.version && <span className="mono hint">{t.version}</span>}
        </div>
        {!ready && (
          <>
            <pre className="fix" data-testid="setup-fix">
              {t.fix || S.setup.fixMissing}
            </pre>
            <Button
              variant="outline"
              size="sm"
              data-testid="setup-copy"
              data-key={t.tool}
              onClick={() => void copyFix(t)}
            >
              {S.common.copy}
            </Button>
            <Message actionKey={"setup-" + t.tool} />
          </>
        )}
      </section>
    );
  }

  return (
    <>
      {data.setup.tools.map(renderTool)}
    </>
  );
}
