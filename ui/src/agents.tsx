/** The Teams tab: teams of custom AI agents, each with its own harness. */
import { useState, type ReactNode } from "react";
import { Bot, FolderCog, Plug, Plus, ShieldCheck, Trash2 } from "lucide-react";
import {
  S,
  api,
  enc,
  fmt,
  memberHref,
  toolName,
  toolOK,
  type Access,
  type Member,
  type McpServer,
  type PageData,
  type Role,
  type Team,
} from "./lib/api";
import {
  AddDialog,
  Button,
  Card,
  Checks,
  Crumbs,
  Details,
  EmptyState,
  Field,
  Form,
  Hint,
  Input,
  Label,
  Limit,
  Message,
  Picker,
  Remove,
  formValue,
  limitValue,
  selected,
} from "./shared";
import { PageIntro, TeamForm } from "./pages";

const ACCESS: { value: Access; label: string; hint: string }[] = [
  { value: "full", label: S.agents.accessFull, hint: S.agents.accessFullHint },
  { value: "edit", label: S.agents.accessEdit, hint: S.agents.accessEditHint },
  { value: "read", label: S.agents.accessRead, hint: S.agents.accessReadHint },
  { value: "custom", label: S.agents.accessCustom, hint: S.agents.accessCustomHint },
];
export const accessText = (a?: Access) => ACCESS.find((x) => x.value === (a ?? "full"))!.label;

interface McpRow {
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  env: string;
}
const toRow = (s: McpServer): McpRow => ({
  name: s.name,
  type: s.type,
  command: s.command ?? "",
  args: (s.args ?? []).join("\n"),
  url: s.url ?? "",
  env: Object.keys(s.env ?? {}).map((k) => k + "=").join("\n"),
});
function fromRow(r: McpRow) {
  const env: Record<string, string> = {};
  for (const line of r.env.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return r.type === "http"
    ? { name: r.name.trim(), type: "http", url: r.url.trim(), env }
    : { name: r.name.trim(), type: "stdio", command: r.command.trim(), args: r.args.split("\n").map((a) => a.trim()).filter(Boolean), env };
}

function McpEditor({ rows, setRows }: { rows: McpRow[]; setRows: (rows: McpRow[]) => void }) {
  const change = (i: number, patch: Partial<McpRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="mcp-editor">
      <legend>{S.agents.mcp}</legend>
      <Hint>{S.agents.mcpHint}</Hint>
      {rows.map((r, i) => (
        <div className="mcp-row" key={i} data-testid="mcp-row">
          <div className="mcp-row-head">
            <Input
              aria-label={S.agents.mcpName}
              placeholder={S.agents.mcpName + " (github)"}
              data-testid="mcp-name"
              value={r.name}
              onChange={(e) => change(i, { name: e.target.value })}
            />
            <select
              className="native-select"
              aria-label={S.agents.mcpType}
              data-testid="mcp-type"
              value={r.type}
              onChange={(e) => change(i, { type: e.target.value as McpRow["type"] })}
            >
              <option value="stdio">{S.agents.mcpLocal}</option>
              <option value="http">{S.agents.mcpRemote}</option>
            </select>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={S.agents.mcpRemove} title={S.agents.mcpRemove} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
          {r.type === "http" ? (
            <Input aria-label={S.agents.mcpUrl} placeholder="https://…" data-testid="mcp-url" value={r.url} onChange={(e) => change(i, { url: e.target.value })} />
          ) : (
            <>
              <Input aria-label={S.agents.mcpCommand} placeholder={S.agents.mcpCommand + " (npx)"} data-testid="mcp-command" value={r.command} onChange={(e) => change(i, { command: e.target.value })} />
              <textarea className="textarea" rows={2} aria-label={S.agents.mcpArgs} placeholder={S.agents.mcpArgs} data-testid="mcp-args" value={r.args} onChange={(e) => change(i, { args: e.target.value })} />
            </>
          )}
          <textarea className="textarea mono" rows={2} aria-label={S.agents.mcpEnv} placeholder={S.agents.mcpEnv} data-testid="mcp-env" value={r.env} onChange={(e) => change(i, { env: e.target.value })} />
          <Hint>{S.agents.mcpEnvHint}</Hint>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        data-testid="mcp-add"
        onClick={() => setRows([...rows, { name: "", type: "stdio", command: "", args: "", url: "", env: "" }])}
      >
        <Plus aria-hidden="true" />
        {S.agents.mcpAdd}
      </Button>
    </fieldset>
  );
}

/** Everything the form starts from: an agent being edited, a template, or blank. */
interface Start {
  tool: string;
  model?: string;
  specialty?: string;
  timeLimitMinutes?: number;
  instructions?: string;
  skills: string[];
  access: Access;
  allow: string[];
  deny: string[];
  isolated: boolean;
  mcp: McpServer[];
}
function startFrom(data: PageData, member?: Member, role?: Role): Start {
  const h = member?.harness;
  const tool = member?.tool ?? role?.tool ?? ["claude", "codex"].find((t) => toolOK(data.setup, t)) ?? "claude";
  return {
    tool,
    model: member?.model ?? role?.model,
    specialty: member?.specialty ?? role?.specialty,
    timeLimitMinutes: member?.timeLimitMinutes ?? role?.timeLimitMinutes,
    instructions: member ? member.ownInstructions : role?.instructions,
    skills: member ? member.skills.filter((s) => s.source === "member").map((s) => s.name) : role?.skills ?? [],
    access: h?.access ?? "full",
    allow: h?.allow ?? [],
    deny: h?.deny ?? [],
    // New agents keep to their own settings by default; existing ones keep what they had.
    isolated: h ? h.isolated : true,
    mcp: h?.mcp ?? [],
  };
}

function AgentFields({ data, start, member, role }: { data: PageData; start: Start; member?: Member; role?: string }) {
  const [tool, setTool] = useState(start.tool);
  const [access, setAccess] = useState<Access>(start.access);
  const [rows, setRows] = useState<McpRow[]>(start.mcp.map(toRow));
  const claude = tool === "claude";
  const followsRole = !!member?.specialist;
  return (
    <>
      <input type="hidden" name="agent-tool" value={tool} />
      <input type="hidden" name="agent-access" value={access} />
      <input type="hidden" name="agent-mcp" value={JSON.stringify(rows.map(fromRow))} />
      {!member && <Field id="agent-name" label={S.agents.name} placeholder={S.wording.helperName} hint={S.wording.nameRules} />}
      {followsRole ? (
        <Hint>{fmt(S.agents.followsRole, { role: member!.specialist! })}</Hint>
      ) : (
        <>
          <Field id="agent-job" label={S.agents.job} defaultValue={start.specialty} placeholder={S.agents.jobHint} maxLength={200} />
          <div className="agent-row">
            <Picker
              id="agent-tool-pick"
              label={S.common.tool}
              setup={data.setup}
              value={tool}
              onChange={(v) => {
                setTool(v);
                if (v !== "claude" && access === "custom") setAccess("full");
              }}
              options={["claude", "codex"].map((t) => ({ value: t, tool: t, label: toolName(t) }))}
            />
            <Field id="agent-model" label={S.common.model} defaultValue={start.model} placeholder={S.common.defaultModel} />
          </div>
        </>
      )}
      <Limit id="agent-limit" value={start.timeLimitMinutes} hint={role || followsRole ? S.wording.roleLimit : S.common.timeHint} />
      <Field
        id="agent-instructions"
        label={S.agents.instructions}
        multiline
        defaultValue={start.instructions}
        hint={S.agents.instructionsHint + (followsRole ? " " + S.agents.roleInstructions : "")}
      />
      <fieldset className="access-choices" role="radiogroup" aria-label={S.agents.access}>
        <legend>{S.agents.access}</legend>
        {ACCESS.filter((a) => claude || a.value !== "custom").map((a) => (
          <label key={a.value} className="access-choice" data-checked={access === a.value}>
            <input type="radio" name="agent-access-choice" value={a.value} checked={access === a.value} onChange={() => setAccess(a.value)} data-testid="agent-access" />
            <span>
              <strong>{a.label}</strong>
              <span className="hint">{a.hint}</span>
            </span>
          </label>
        ))}
        {!claude && <Hint>{S.agents.claudeOnly}</Hint>}
      </fieldset>
      {claude && access === "custom" && (
        <div className="agent-row">
          <Field id="agent-allow" label={S.agents.allow} multiline defaultValue={start.allow.join("\n")} placeholder={"Read\nGlob\nBash(npm test:*)"} />
          <Field id="agent-deny" label={S.agents.deny} multiline defaultValue={start.deny.join("\n")} placeholder={"Bash(git push:*)"} />
        </div>
      )}
      {claude && access === "custom" && <Hint>{S.agents.rulesHint}</Hint>}
      {claude && (
        <label className="check-line">
          <input type="checkbox" name="agent-isolated" defaultChecked={start.isolated} data-testid="agent-isolated" />
          <span>
            <strong>{S.agents.isolated}</strong>
            <span className="hint">{S.agents.isolatedHint}</span>
          </span>
        </label>
      )}
      <McpEditor rows={rows} setRows={setRows} />
      <Checks id="agent-skill" names={data.skills?.skills.map((s) => s.name) ?? []} values={start.skills} label={S.common.skills} skills />
    </>
  );
}

/** Add an agent to a team, or edit one. New agents can start from a template (a saved role). */
export function AgentForm({ data, team, member }: { data: PageData; team: string; member?: Member }) {
  const roles = data.roles ?? [];
  const [template, setTemplate] = useState("");
  const role = roles.find((r) => r.name === template);
  const key = member ? "agent-edit-" + team + "-" + member.member : "agent-add-" + team;
  return (
    <Form
      id={member ? "agent-edit-form" : "agent-add-form"}
      itemKey={member?.member ?? team}
      actionKey={key}
      success={member ? S.common.saved : S.common.added}
      onSubmit={async (f) => {
        const access = formValue(f, "agent-access") as Access;
        const tool = formValue(f, "agent-tool");
        const body: Record<string, unknown> = {
          timeLimitMinutes: limitValue(f, "agent-limit"),
          skills: selected(f, "agent-skill"),
          instructions: formValue(f, "agent-instructions"),
          access,
          mcp: JSON.parse(formValue(f, "agent-mcp") || "[]"),
        };
        if (!member?.specialist) {
          Object.assign(body, { tool, model: formValue(f, "agent-model").trim(), specialty: formValue(f, "agent-job").trim() });
        }
        if (tool === "claude") body.isolated = (f.elements.namedItem("agent-isolated") as HTMLInputElement | null)?.checked === true;
        if (access === "custom") Object.assign(body, { allow: formValue(f, "agent-allow"), deny: formValue(f, "agent-deny") });
        if (!member) body.name = formValue(f, "agent-name").trim() || undefined;
        await api("teams/" + enc(team) + "/members" + (member ? "/" + enc(member.member) + "/edit" : ""), body);
      }}
    >
      {!member && roles.length > 0 && (
        <div className="field">
          <Label htmlFor={"agent-template-" + team}>{S.agents.template}</Label>
          <select
            id={"agent-template-" + team}
            className="native-select"
            data-testid="agent-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="">{S.agents.blank}</option>
            {roles.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name + " · " + r.specialty}
              </option>
            ))}
          </select>
          <Hint>{S.agents.templateHint}</Hint>
        </div>
      )}
      {/* A new template restarts the fields with its values. */}
      <AgentFields key={template} data={data} start={startFrom(data, member, role)} member={member} role={template} />
      <div className="submit-row">
        <Button type="submit" data-testid="agent-save">
          {member ? S.common.save : S.agents.add}
        </Button>
      </div>
    </Form>
  );
}

function AgentCard({ team, m }: { team: string; m: Member }) {
  const n = m.member || m.name!;
  const h = m.harness;
  return (
    <li className="agent-card" data-testid="agent-card" data-key={team + "/" + n}>
      <span className={"home-icon " + m.tool} aria-hidden="true">
        <Bot />
      </span>
      <div className="agent-card-body">
        <div className="agent-card-title">
          <a className="link" href={memberHref(team, n)}>
            <strong>{n}</strong>
          </a>
          {m.working?.length ? <span className="status working">{S.tasks.working}</span> : null}
          {m.error && <span className="status needs">{S.members.broken}</span>}
        </div>
        <span className="hint">
          {m.specialist ? fmt(S.members.copyOf, { name: m.specialist }) + (m.specialty ? " · " + m.specialty : "") : m.specialty || S.members.worker}
        </span>
        <div className="home-chips">
          <span className="status quiet">
            {toolName(m.tool)}
            {m.model ? " · " + m.model : ""}
          </span>
          <span className={"status " + (h?.access === "full" || !h ? "quiet" : "review")}>
            <ShieldCheck aria-hidden="true" className="chip-icon" />
            {accessText(h?.access)}
          </span>
          {!!h?.mcp.length && (
            <span className="status working">
              <Plug aria-hidden="true" className="chip-icon" />
              {h.mcp.map((s) => s.name).join(", ")}
            </span>
          )}
          {h?.isolated && (
            <span className="status quiet">
              <FolderCog aria-hidden="true" className="chip-icon" />
              {S.agents.isolatedYes}
            </span>
          )}
        </div>
      </div>
      <Remove kind="member" name={team + "/" + n} route={"teams/" + enc(team) + "/members/" + enc(n) + "/remove"} actionKey={"member-" + team + "-" + n}>
        {S.members.remove}
      </Remove>
    </li>
  );
}

function TeamCard({ t, data }: { t: Team; data: PageData }) {
  return (
    <Card className="panel" data-key={t.name} data-testid="team-card">
      <div className="page-head">
        <div>
          <h2>{t.name}</h2>
          <p className="badge-row hint">
            {S.teams.projects}:{" "}
            {t.projects.length
              ? t.projects.map((p) => (
                  <a key={p} className="badge link" href={"#/project/" + enc(p)}>
                    {p}
                  </a>
                ))
              : S.common.none}
          </p>
        </div>
        <div className="button-row">
          <AddDialog id="team-edit-open" label={S.teams.edit} title={S.teams.edit + " · " + t.name} variant="outline" itemKey={t.name} closeOnSave={false} wide>
            <TeamForm team={t} data={data} />
          </AddDialog>
          <AddDialog id="agent-add-open" label={S.agents.add} title={S.agents.add + " · " + t.name} itemKey={t.name} wide>
            <AgentForm data={data} team={t.name} />
          </AddDialog>
          <Remove kind="team" name={t.name} route={"teams/" + enc(t.name) + "/remove"} actionKey={"team-" + t.name}>
            {S.teams.remove}
          </Remove>
        </div>
      </div>
      <Message actionKey={"team-" + t.name} />
      {t.members.length ? (
        <ul className="agent-list">
          {t.members.map((m) => (
            <AgentCard key={m.member || m.name} team={t.name} m={m} />
          ))}
        </ul>
      ) : (
        <Hint>{S.agents.none}</Hint>
      )}
      {t.members.map((m) => (
        <Message key={m.member || m.name} actionKey={"member-" + t.name + "-" + (m.member || m.name)} />
      ))}
    </Card>
  );
}

export function TeamsPage({ data }: { data: PageData }) {
  const teams = data.teams ?? [];
  return (
    <>
      <Crumbs>{S.nav.teams}</Crumbs>
      <PageIntro title={S.teams.title}>
        <div className="button-row">
          {(data.roles?.length ?? 0) > 0 && (
            <Button asChild variant="outline">
              <a href="#/specialists" data-testid="templates-link">
                {S.agents.templates}
              </a>
            </Button>
          )}
          <AddDialog id="team-add-open" label={S.teams.add} title={S.teams.add}>
            <TeamForm data={data} />
          </AddDialog>
        </div>
      </PageIntro>
      {!teams.length && <EmptyState id="teams-empty">{S.teams.emptyAdd}</EmptyState>}
      {teams.map((t) => (
        <TeamCard key={t.name} t={t} data={data} />
      ))}
    </>
  );
}

/** The harness summary on an agent's own page. */
export function HarnessCard({ m }: { m: Member }) {
  const h = m.harness;
  if (!h) return null;
  return (
    <Card className="panel" data-testid="agent-harness">
      <h2>{S.agents.harness}</h2>
      <Details
        pairs={[
          [S.agents.access, accessText(h.access)],
          ...(h.access === "custom"
            ? ([
                [S.agents.allowed, <span className="mono">{h.allow.join(", ") || S.common.none}</span>],
                [S.agents.blocked, <span className="mono">{h.deny.join(", ") || S.common.none}</span>],
              ] as [string, ReactNode][])
            : []),
          ...(m.tool === "claude" ? ([[S.agents.settings, h.isolated ? S.agents.isolatedYes : S.agents.isolatedNo]] as [string, ReactNode][]) : []),
          [S.agents.mcp, h.mcp.length ? h.mcp.map((s) => s.name + (s.type === "http" ? " (" + s.url + ")" : " (" + s.command + ")")).join(", ") : S.agents.noMcp],
          ...(m.folder ? ([[S.agents.folder, <span className="mono" data-testid="agent-folder">{m.folder}</span>]] as [string, ReactNode][]) : []),
        ]}
      />
    </Card>
  );
}
