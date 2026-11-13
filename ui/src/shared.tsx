import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
  type ComponentProps,
} from "react";
import {
  AlertDialog,
  Checkbox,
  Dialog,
  Collapsible,
  ScrollArea,
  Tooltip,
  ToggleGroup,
} from "radix-ui";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Folder,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { Input } from "./components/ui/input";
import { Alert } from "./components/ui/alert";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
} from "./components/ui/select";
import {
  api,
  enc,
  S,
  fmt,
  errorText,
  RequestError,
  toolName,
  toolOK,
  toolProblem,
  stateText,
  whoText,
  when,
  snippet,
  type Setup,
  type Run,
} from "./lib/api";
export { Button, Card, Input, Label };
export interface Effect {
  what: string;
  kind: "lost" | "kept";
}
export interface Confirmation {
  title: string;
  effects: Effect[];
  blocked?: string;
  label?: string;
  clean?: boolean;
  deleteBranch?: boolean;
  action: (deleteBranch: boolean) => Promise<unknown>;
}
export interface MessageData {
  text: string;
  success?: boolean;
  error?: RequestError;
}
export interface AppActions {
  messages: Record<string, MessageData>;
  pending: Record<string, boolean>;
  tell: (
    key: string,
    text: string,
    success?: boolean,
    error?: RequestError,
  ) => void;
  act: (
    key: string,
    action: () => Promise<unknown>,
    success?: string,
  ) => Promise<boolean>;
  confirm: (dialog: Confirmation) => void;
  refresh: () => void;
}
export const Actions = createContext<AppActions>(null!);
export const useActions = () => useContext(Actions);
export function Hint({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>;
}
export function Notice({
  children,
  id,
  danger = false,
  tone = "info",
}: {
  children: ReactNode;
  id?: string;
  danger?: boolean;
  tone?: "info" | "needs" | "done";
}) {
  return (
    <Alert
      role="status"
      data-testid={id}
      variant={danger ? "destructive" : "default"}
      className={danger ? "" : "notice " + tone}
    >
      <div className="col-start-2">{children}</div>
    </Alert>
  );
}
export function Skeleton() {
  return (
    <div data-testid="page-loading" aria-busy="true" className="space-y-4">
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-40" />
      <div className="skeleton h-24" />
    </div>
  );
}
export function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} className="tooltip">
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
function Scroll({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ScrollArea.Root className={"scroll-area " + className}>
      <ScrollArea.Viewport className="scroll-viewport">
        {children}
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation="vertical" className="scrollbar">
        <ScrollArea.Thumb className="scroll-thumb" />
      </ScrollArea.Scrollbar>
      <ScrollArea.Scrollbar
        orientation="horizontal"
        className="scrollbar horizontal"
      >
        <ScrollArea.Thumb className="scroll-thumb" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
/** Closes the surrounding AddDialog once a form inside it saves. */
const DialogDone = createContext<(() => void) | null>(null);
/**
 * A primary "+ Add …" button that opens its form in a dialog,
 * so pages stay clean until the owner wants to add something.
 */
export function AddDialog({
  id,
  label,
  title,
  description,
  initial = false,
  variant,
  itemKey,
  wide = false,
  closeOnSave = true,
  plus = !variant,
  children,
}: {
  id: string;
  label: string;
  title: string;
  description?: ReactNode;
  initial?: boolean;
  variant?: "outline";
  itemKey?: string;
  wide?: boolean;
  /** False for a dialog holding several separate settings forms. */
  closeOnSave?: boolean;
  /** Show the "+" icon (adding something new). */
  plus?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initial);
  const { pending } = useActions();
  const busy = Object.values(pending).some(Boolean);
  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v || !busy) && setOpen(v)}>
      <Dialog.Trigger asChild>
        <Button data-testid={id} data-key={itemKey} variant={variant}>
          {plus && <Plus aria-hidden="true" />}
          {label}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={"confirm-dialog add-dialog" + (wide ? " wide" : "")} data-testid={id + "-dialog"} aria-describedby={undefined}>
          <div className="add-dialog-head">
            <Dialog.Title asChild>
              <h2>{title}</h2>
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={S.common.close} title={S.common.close}>
                <X aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          {description && <div className="hint">{description}</div>}
          <DialogDone.Provider value={closeOnSave ? () => setOpen(false) : null}>{children}</DialogDone.Provider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
/** Close the surrounding AddDialog, for actions outside a Form submit. */
export const useDialogDone = () => useContext(DialogDone);
/** An empty page's message, shown where the list will be. */
export function EmptyState({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div className="empty-state" data-testid={id}>
      {children}
    </div>
  );
}
export function Disclosure({
  id,
  title,
  children,
  itemKey,
  initial = false,
  header,
  beforeContent,
}: {
  id: string;
  title: string;
  children: ReactNode;
  itemKey?: string;
  initial?: boolean;
  header?: { title: ReactNode; description?: ReactNode };
  beforeContent?: ReactNode;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      data-key={itemKey}
      className={header ? "disclosure list-disclosure" : "disclosure"}
    >
      {header ? (
        <div className="page-head">
          <div>
            <h1>{header.title}</h1>
            {header.description && (
              <div className="description">{header.description}</div>
            )}
          </div>
          <Collapsible.Trigger asChild>
            <Button
              type="button"
              variant="outline"
              data-testid={id}
              data-key={itemKey}
            >
              {title}
              <ChevronDown
                aria-hidden="true"
                className={open ? "rotate-180" : ""}
              />
            </Button>
          </Collapsible.Trigger>
        </div>
      ) : (
        <>
          <Collapsible.Trigger asChild>
            <Button
              type="button"
              variant="outline"
              data-testid={id}
              data-key={itemKey}
            >
              {title}
              <ChevronDown
                aria-hidden="true"
                className={open ? "rotate-180" : ""}
              />
            </Button>
          </Collapsible.Trigger>
        </>
      )}

      {beforeContent}
      <Collapsible.Content className="disclosure-content">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
export function Crumbs({ children }: { children?: ReactNode }) {
  return (
    <nav aria-label={S.nav.projects} className="crumbs">
      <ol>
        <li>
          <a href="#/projects">{S.nav.projects}</a>
        </li>
        {children && (
          <li>
            <span aria-hidden="true"> / </span>
            {children}
          </li>
        )}
      </ol>
    </nav>
  );
}
export function Field({
  id,
  label,
  hint,
  multiline,
  ...props
}: {
  id: string;
  label: string;
  hint?: string;
  multiline?: boolean;
} & ComponentProps<"input">) {
  const uid = useId();
  const controlId = id + uid;
  return (
    <div className="field">
      <Label htmlFor={controlId}>{label}</Label>
      {multiline ? (
        <textarea
          {...(props as ComponentProps<"textarea">)}
          id={controlId}
          name={id}
          data-testid={id}
          className="textarea"
        />
      ) : (
        <Input {...props} id={controlId} name={id} data-testid={id} />
      )}
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}
export function Limit({
  id,
  value,
  hint = S.common.timeHint,
}: {
  id: string;
  value?: number;
  hint?: string;
}) {
  const [invalid, setInvalid] = useState(false);
  return (
    <div>
      <Field
        id={id}
        label={S.common.timeLimit}
        type="number"
        min="0"
        max="1440"
        step="any"
        defaultValue={value}
        placeholder={value === undefined ? hint : S.wording.keepLimit}
        hint={value === undefined ? hint : S.wording.keepLimit}
        className="limit"
        onBlur={(e) =>
          setInvalid(
            e.target.value !== "" &&
              (+e.target.value <= 0 || +e.target.value > 1440),
          )
        }
        onChange={(e) => {
          const bad =
            e.target.value !== "" &&
            (+e.target.value <= 0 || +e.target.value > 1440);
          e.target.setCustomValidity(bad ? S.common.timeInvalid : "");
          if (!bad) setInvalid(false);
        }}
      />
      {invalid && (
        <p role="status" className="error">
          {S.common.timeInvalid}
        </p>
      )}
    </div>
  );
}
export function formValue(form: HTMLFormElement, name: string) {
  return String(new FormData(form).get(name) ?? "");
}
export function limitValue(form: HTMLFormElement, name: string) {
  const v = formValue(form, name);
  if (!v) return undefined;
  if (!Number.isFinite(+v) || +v <= 0 || +v > 1440)
    throw new RequestError(S.common.timeInvalid);
  return +v;
}
export function selected(form: HTMLFormElement, name: string) {
  return new FormData(form).getAll(name).map(String);
}
export function Checks({
  id,
  names,
  values = [],
  label,
  skills = false,
}: {
  id: string;
  names: string[];
  values?: string[];
  label: string;
  skills?: boolean;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {skills && <Hint>{S.wording.skillsIntro}</Hint>}
      {names.length ? (
        <Scroll className="check-scroll">
          <div className="checks">
            {names.map((name) => (
              <CheckRow
                key={name}
                id={id}
                name={name}
                checked={values.includes(name)}
              />
            ))}
          </div>
        </Scroll>
      ) : (
        <Hint>{S.common.noneAvailable}</Hint>
      )}
    </fieldset>
  );
}
function CheckRow({
  id,
  name,
  checked,
}: {
  id: string;
  name: string;
  checked: boolean;
}) {
  const uid = useId();
  return (
    <Label htmlFor={uid} className="check-row">
      <Checkbox.Root
        className="checkbox"
        id={uid}
        name={id}
        value={name}
        defaultChecked={checked}
        data-testid={id}
        data-key={name}
      >
        <Checkbox.Indicator>
          <Check size={14} />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span>{name}</span>
    </Label>
  );
}
export interface Option {
  value: string;
  dataKey?: string;
  label: string;
  tool?: string;
  group?: string;
}
export function Picker({
  id,
  label,
  options,
  value,
  onChange,
  setup,
  required,
  itemKey,
  disabled,
}: {
  id: string;
  label: string;
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  setup?: Setup;
  required?: boolean;
  itemKey?: string;
  disabled?: boolean;
}) {
  const uid = useId();
  const groups = [...new Set(options.map((o) => o.group))];
  const allBad =
    !!setup &&
    options.length > 0 &&
    options.every((o) => o.tool && !toolOK(setup, o.tool));
  return (
    <div className="field">
      {allBad && (
        <Notice>
          {options
            .map((o) => o.tool && toolProblem(setup!, o.tool))
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(" ")}{" "}
          <a className="link" href="#/profile/setup">
            {S.nav.setup}
          </a>
        </Notice>
      )}
      <Label htmlFor={uid}>{label}</Label>
      <Select
        value={value}
        onValueChange={onChange}
        required={required}
        disabled={disabled}
      >
        <SelectTrigger
          id={uid}
          data-testid={id}
          data-key={itemKey}
          className="picker"
        >
          <SelectValue placeholder={S.common.noneAvailable} />
        </SelectTrigger>
        <SelectContent>
          {groups.map((group, i) => (
            <SelectGroup key={group || i}>
              {group && <SelectLabel>{group}</SelectLabel>}
              {options
                .filter((o) => o.group === group)
                .map((o) => (
                  <SelectItem
                    key={o.value}
                    value={o.value}
                    data-key={o.dataKey ?? o.value}
                    disabled={!!(setup && o.tool && !toolOK(setup, o.tool))}
                    textValue={o.label}
                  >
                    <span>
                      {o.label}
                      {setup && o.tool && !toolOK(setup, o.tool) && (
                        <span className="block text-[13px] text-muted-foreground">
                          {S.common.unavailable}: {toolProblem(setup, o.tool)}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function ToolPicker({
  id,
  setup,
  initial,
  onChange,
}: {
  id: string;
  setup: Setup;
  initial?: string;
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = useState(
    initial || ["claude", "codex"].find((t) => toolOK(setup, t)) || "",
  );
  return (
    <>
      <input type="hidden" name={id} value={value} />
      <Picker
        id={id}
        label={S.common.tool}
        setup={setup}
        required
        options={["claude", "codex"].map((t) => ({
          value: t,
          tool: t,
          label: toolName(t),
        }))}
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
    </>
  );
}
export function Submit({
  id,
  children,
  actionKey,
  disabled,
}: {
  id: string;
  children: ReactNode;
  actionKey: string;
  disabled?: boolean;
}) {
  const { pending } = useActions();
  return (
    <div className="submit-row">
      <Button
        type="submit"
        data-testid={id}
        disabled={disabled || pending[actionKey]}
      >
        {pending[actionKey] && (
          <LoaderCircle className="spin" aria-hidden="true" />
        )}
        {children}
      </Button>
    </div>
  );
}
export function Form({
  id,
  itemKey,
  actionKey,
  children,
  onSubmit,
  success = S.common.saved,
  onInput,
}: {
  id: string;
  itemKey?: string;
  actionKey: string;
  children: ReactNode;
  onSubmit: (form: HTMLFormElement) => Promise<unknown>;
  success?: string;
  onInput?: () => void;
}) {
  const { act } = useActions();
  const done = useContext(DialogDone);
  return (
    <form
      className="form"
      data-testid={id}
      data-key={itemKey}
      onInput={onInput}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = e.currentTarget;
        // A form returns false to stay open (e.g. it asked a follow-up question).
        let keep = false;
        void act(actionKey, async () => { keep = (await onSubmit(f)) === false; }, success).then((ok) => ok && !keep && done?.());
      }}
    >
      {children}
      <Message actionKey={actionKey} />
    </form>
  );
}
export function Message({ actionKey }: { actionKey: string }) {
  const { messages, tell, confirm, act } = useActions();
  const m = messages[actionKey],
    e = m?.error;
  return (
    <div
      role="status"
      data-testid="action-message"
      data-message-key={actionKey}
      className={"message " + (m?.success ? "success" : "error")}
    >
      {m?.text && (
        <>
          <span className="message-text">
            {m.success ? (
              <Check aria-hidden="true" size={16} />
            ) : (
              <AlertCircle aria-hidden="true" size={16} />
            )}
            {m.text}
          </span>
          {e?.suggestion && (
            <span>
              {fmt(S.wording.tryName, { suggestion: e.suggestion })}{" "}
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="use-suggested-name"
                onClick={(event) => {
                  const form = event.currentTarget.closest("form");
                  const input = form?.querySelector<HTMLInputElement>(
                    '[data-testid$="-name"]',
                  );
                  if (input) {
                    input.value = e.suggestion!;
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                    input.focus();
                    tell(actionKey, "");
                  } else if (form) {
                    form.dataset.skillName = e.suggestion;
                    form.requestSubmit();
                  }
                }}
              >
                {S.wording.useName}
              </Button>
            </span>
          )}
          {e?.code === "project_registered" && (
            <a
              className="link"
              href={"#/project/" + enc(String(e.params?.name))}
            >
              {fmt(S.wording.openProject, e.params)}
            </a>
          )}
          {e?.code &&
            ["tool_unavailable", "spawn_failed", "identity_missing"].includes(
              e.code,
            ) && (
              <a className="link" href="#/profile/setup">
                {S.nav.setup}
              </a>
            )}
          {e?.code?.startsWith("account_") && (
            <a className="link" href="#/accounts">
              {S.accounts.open}
            </a>
          )}
          {e?.links?.map((l) => (
            <a key={l.id} className="link" href={"#/run/" + enc(l.id)}>
              {snippet(l.task, 40)}
            </a>
          ))}
          {e?.code === "skill_exists" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="skill-replace"
              onClick={() =>
                confirm({
                  title: fmt(S.wording.replaceTitle, e.params),
                  effects: [{ what: S.wording.replaceEffect, kind: "lost" }],
                  label: S.wording.replace,
                  action: async () => {
                    await e.replaceSkill?.();
                    tell(actionKey, S.common.added, true);
                  },
                })
              }
            >
              {S.wording.replace}
            </Button>
          )}
          {e &&
            (!e.code ||
              !Object.hasOwn(S.errors, e.code) ||
              e.code === "unknown_error") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="copy-details"
                onClick={() =>
                  void act(
                    actionKey,
                    async () => {
                      const d = await api<{ logPath: string; time: string }>(
                        "error-details",
                      );
                      await navigator.clipboard.writeText(
                        d.logPath + "\n" + d.time,
                      );
                    },
                    S.wording.detailsCopied,
                  )
                }
              >
                {S.wording.copyDetails}
              </Button>
            )}
        </>
      )}
    </div>
  );
}
export function Remove({
  kind,
  name,
  route,
  actionKey,
  children,
  after,
}: {
  kind: string;
  name: string;
  route: string;
  actionKey: string;
  children: ReactNode;
  after?: () => void;
}) {
  const { act, confirm, pending, tell } = useActions();
  return (
    <Button
      type="button"
      variant="outline"
      className="remove"
      data-testid={kind + "-remove"}
      data-key={name}
      disabled={pending[actionKey]}
      onClick={() =>
        void act(
          actionKey,
          async () => {
            const p = await api<{
              removalText?: string;
              effects: Effect[];
              blocked: boolean;
              blockedReason?: string;
            }>("remove-preview?kind=" + enc(kind) + "&name=" + enc(name));
            confirm({
              title: p.removalText || fmt(S.confirm.title, { name }),
              effects: p.effects,
              blocked: p.blocked
                ? p.blockedReason || S.confirm.blocked
                : undefined,
              action: async () => {
                await api(route, {});
                tell(actionKey, S.common.removed, true);
                after?.();
              },
            });
          },
          "",
        )
      }
    >
      {children}
    </Button>
  );
}
export function ConfirmDialog({
  dialog,
  close,
}: {
  dialog: Confirmation | null;
  close: () => void;
}) {
  const { act, pending, tell } = useActions();
  const cancel = useRef<HTMLButtonElement>(null);
  const [deleteBranch, setDeleteBranch] = useState(
    dialog?.deleteBranch || false,
  );
  return (
    <AlertDialog.Root
      open={!!dialog}
      onOpenChange={(v) => {
        if (!v && !pending.dialog) close();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content
          data-testid="confirm-dialog"
          className="confirm-dialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancel.current?.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (pending.dialog) e.preventDefault();
          }}
        >
          <AlertDialog.Title asChild>
            <h2>{dialog?.title}</h2>
          </AlertDialog.Title>
          <AlertDialog.Description className="hint">
            {S.confirm.hint}
          </AlertDialog.Description>
          <ul data-testid="confirm-effects" className="effects">
            {dialog?.effects.length ? (
              dialog.effects.map((e, i) => (
                <li key={i}>
                  <span
                    aria-hidden="true"
                    className={e.kind === "lost" ? "error" : "success"}
                  >
                    {e.kind === "lost" ? "⚠" : "✓"}
                  </span>
                  <span>{e.what}</span>
                </li>
              ))
            ) : (
              <li>{S.confirm.noEffects}</li>
            )}
          </ul>
          {dialog?.clean && (
            <>
              <Hint>{S.wording.workspace}</Hint>
              <label className="check-row">
                <Checkbox.Root
                  className="checkbox"
                  checked={deleteBranch}
                  onCheckedChange={(v) => setDeleteBranch(v === true)}
                  data-testid="task-delete-branch"
                >
                  <Checkbox.Indicator>
                    <Check size={14} />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                {S.tasks.deleteBranch}
              </label>
            </>
          )}
          {dialog?.blocked && (
            <Notice danger id="confirm-blocked">
              {dialog.blocked}
            </Notice>
          )}
          <Message actionKey="dialog" />
          <div className="button-row justify-end">
            <AlertDialog.Cancel asChild>
              <Button
                ref={cancel}
                variant="outline"
                disabled={pending.dialog}
                data-testid="confirm-cancel"
              >
                {S.common.cancel}
              </Button>
            </AlertDialog.Cancel>
            {dialog && !dialog.blocked && (
              <Button
                variant="destructive"
                disabled={pending.dialog}
                data-testid="confirm-submit"
                onClick={() =>
                  void act(
                    "dialog",
                    async () => {
                      tell("dialog", "");
                      await dialog.action(deleteBranch);
                      close();
                    },
                    "",
                  )
                }
              >
                {pending.dialog && (
                  <LoaderCircle className="spin" aria-hidden="true" />
                )}
                {dialog.label || S.confirm.remove}
              </Button>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
export function StatusBadge({
  run,
  text,
  tone = "done",
  muted = false,
}: {
  run?: Run;
  text?: string;
  tone?: string;
  muted?: boolean;
}) {
  if (run)
    tone =
      run.state === "running"
        ? "working"
        : run.reviewStatus === "unsaved" ||
            run.reviewStatus === "unavailable" ||
            run.lostAt ||
            ["failed", "stopped", "timed_out"].includes(run.state)
          ? "needs"
          : "done";
  return (
    <span className={"status " + (muted ? "quiet" : tone)}>
      <span
        aria-hidden="true"
        className={"dot " + (tone === "working" && !muted ? "pulse" : "")}
      />
      {run ? stateText(run) : text}
    </span>
  );
}
export function Table({
  headers,
  children,
  className = "",
}: {
  headers: string[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={"table-wrap " + className}>
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th scope="col" key={i}>
                {className.includes("skills-grid") && i > 1 ? (
                  <Tip text={h}>
                    <span tabIndex={0}>{h}</span>
                  </Tip>
                ) : (
                  h
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function TaskTable({
  runs,
  member = false,
}: {
  runs: Run[];
  member?: boolean;
}) {
  return runs.length ? (
    <Table
      className="task-table"
      headers={[
        S.tasks.project,
        ...(member ? [] : [S.tasks.who, S.common.tool]),
        S.tasks.state,
        S.tasks.started,
        S.tasks.task,
      ]}
    >
      {runs.map((r) => (
        <tr
          key={r.runId}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("a"))
              location.hash = "#/run/" + enc(r.runId);
          }}
        >
          <td className="task-project">
            <a className="link" href={"#/project/" + enc(r.project)}>
              {r.project}
            </a>
          </td>
          {!member && (
            <>
              <td className="task-helper">{whoText(r)}</td>
              <td className="task-service">{toolName(r.agent)}</td>
            </>
          )}
          <td className="task-status">
            <StatusBadge run={r} />
          </td>
          <td className="hint task-time">{when(r.startedAt)}</td>
          <td className="task-cell">
            <a
              className="link"
              href={"#/run/" + enc(r.runId)}
              data-testid="task-open"
              data-key={r.runId}
              title={r.task}
            >
              {snippet(r.task)}
            </a>
          </td>
        </tr>
      ))}
    </Table>
  ) : (
    <Hint>{S.tasks.empty}</Hint>
  );
}
export function Details({
  pairs,
  mono = false,
}: {
  pairs: [string, ReactNode][];
  mono?: boolean;
}) {
  return (
    <dl className={"details " + (mono ? "mono" : "")}>
      {pairs.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Activity({ run }: { run: Run }) {
  const ref = useRef<HTMLPreElement>(null);
  const bottom = useRef(true);
  useLayoutEffect(() => {
    if (bottom.current && ref.current)
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [run.log]);
  return (
    <Card className="panel">
      <h2>
        {run.state === "running" && (
          <span aria-hidden="true" className="dot pulse working-dot" />
        )}
        {S.tasks.output}
      </h2>
      <pre
        ref={ref}
        className="log"
        data-testid="task-log"
        onScroll={(e) => {
          const n = e.currentTarget;
          bottom.current = n.scrollTop + n.clientHeight >= n.scrollHeight - 20;
        }}
      >
        {run.log || S.tasks.noOutput}
      </pre>
    </Card>
  );
}
interface Folders {
  path: string;
  parent?: string;
  isGit: boolean;
  hasSkill: boolean;
  folders: { path: string; name: string; isGit: boolean; hasSkill: boolean }[];
}
export function FolderPicker({
  prefix,
  label,
}: {
  prefix: string;
  label: string;
}) {
  const [data, setData] = useState<Folders>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  async function browse(path?: string) {
    const n = ++request.current;
    setOpen(true);
    setLoading(true);
    setError("");
    try {
      const d = await api<Folders>(
        "folders" + (path ? "?path=" + enc(path) : ""),
      );
      if (request.current === n) setData(d);
    } catch (e) {
      if (request.current === n) setError(errorText(e));
    } finally {
      if (request.current === n) setLoading(false);
    }
  }
  /** Put a chosen path in the field as if typed, so the form sees the change. */
  function fill(path: string) {
    const el = input.current;
    if (!el) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, path);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  /** This computer's own folder picker (Finder), or the in-page browser when there isn't one. */
  async function choose() {
    const start = input.current?.value.trim();
    setLoading(true);
    setError("");
    let picked: { path?: string; cancelled?: boolean } = {};
    try {
      picked = await api("folders/choose", start ? { path: start } : {});
    } catch {
      /* Fall back to browsing in the page. */
    } finally {
      setLoading(false);
    }
    if (picked.path) {
      fill(picked.path);
      setOpen(false);
    } else if (!picked.cancelled) void browse(start);
  }
  return (
    <div data-testid="folder-picker">
      <div className="field">
        <Label htmlFor={uid}>{label}</Label>
        <div className="button-row">
          <Input
            ref={input}
            id={uid}
            name={prefix + "-path"}
            data-testid={prefix + "-path"}
            required
            placeholder={S.wording.chooseFolder}
          />
          <Button
            type="button"
            variant="outline"
            data-testid="folder-browse"
            disabled={loading}
            onClick={() => void choose()}
          >
            {S.folder.browse}
          </Button>
        </div>
        <Hint>{S.folder.hint}</Hint>
      </div>
      {open && (
        <section className="folder-panel" data-testid="folder-panel">
          {data && (
            <>
              <div className="button-row justify-between">
                <p className="mono" data-testid="folder-current">
                  {S.folder.current}: <strong>{data.path}</strong>
                </p>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="folder-up"
                  disabled={loading || !data.parent}
                  onClick={() => void browse(data.parent)}
                >
                  {S.folder.up}
                </Button>
              </div>
              <Hint>
                {[
                  data.isGit ? S.folder.tracked : "",
                  data.hasSkill ? S.folder.skill : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Hint>
            </>
          )}
          {loading ? (
            <div aria-busy="true">
              {[1, 2, 3].map((n) => (
                <div key={n} className="skeleton h-10 my-2" />
              ))}
            </div>
          ) : (
            data && (
              <Scroll className="folder-scroll">
                {data.folders.length ? (
                  data.folders.map((f) => (
                    <Button
                      type="button"
                      variant="ghost"
                      className="folder-row"
                      key={f.path}
                      data-testid="folder-entry"
                      data-key={f.path}
                      onClick={() => void browse(f.path)}
                    >
                      <Folder aria-hidden="true" />
                      {f.name}
                      {f.isGit && (
                        <span className="badge">{S.folder.tracked}</span>
                      )}
                      {f.hasSkill && (
                        <span className="badge">{S.folder.skill}</span>
                      )}
                    </Button>
                  ))
                ) : (
                  <Hint>{S.folder.empty}</Hint>
                )}
              </Scroll>
            )
          )}
          {data && (
            <div className="submit-row">
              <Button
                type="button"
                data-testid="folder-use"
                disabled={loading}
                onClick={() => {
                  if (input.current) {
                    input.current.value = data.path;
                    input.current.dispatchEvent(
                      new Event("input", { bubbles: true }),
                    );
                    input.current.focus();
                  }
                  setOpen(false);
                }}
              >
                {S.folder.use}
              </Button>
            </div>
          )}
          <p role="status" data-testid="action-message" className="error">
            {error}
          </p>
        </section>
      )}
    </div>
  );
}
export { Tooltip, ToggleGroup };
