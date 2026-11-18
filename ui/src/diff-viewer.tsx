import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, MessageSquare, LoaderCircle } from "lucide-react";
import { S, api, enc, errorText, fmt, type DiffFile, type DiffLine, type Run, type RunChanges, type FeedbackResult } from "./lib/api";
import { CheckRow, Message, useActions } from "./shared";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./components/ui/dialog";

interface HunkSelection {
  kept: Set<string>;
  toggle: (id: string, checked: boolean) => void;
  saving: boolean;
}

interface LineFeedback {
  comments: Record<string, string>;
  editing?: string;
  draft: string;
  saving: boolean;
  edit: (id: string) => void;
  change: (text: string) => void;
  save: () => void;
  cancel: () => void;
  remove: () => void;
}

function CommentBox({ feedback }: { feedback: LineFeedback }) {
  return <div className="m-3 max-w-xl space-y-2 whitespace-normal rounded-md border bg-background p-3 font-sans text-sm"
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); feedback.cancel(); }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); feedback.save(); }
    }}>
    <Textarea autoFocus aria-label={S.diffViewer.comment} rows={3} maxLength={2000} value={feedback.draft}
      disabled={feedback.saving} onChange={(event) => feedback.change(event.target.value)} />
    <div className="flex gap-2">
      <Button size="sm" disabled={feedback.saving || !feedback.draft.trim()} onClick={feedback.save}>{S.diffViewer.saveComment}</Button>
      <Button size="sm" variant="outline" disabled={feedback.saving} onClick={feedback.cancel}>{S.diffViewer.cancelComment}</Button>
      {feedback.editing && feedback.comments[feedback.editing] !== undefined &&
        <Button size="sm" variant="outline" disabled={feedback.saving} onClick={feedback.remove}>{S.diffViewer.deleteComment}</Button>}
    </div>
  </div>;
}

function HunkCheck({ id, selection }: { id: string; selection?: HunkSelection }) {
  return selection ? <CheckRow id={id} name={S.diffViewer.keepHunk} checked={selection.kept.has(id)}
    onCheckedChange={(checked) => selection.toggle(id, checked)} disabled={selection.saving} /> : null;
}

const EMPTY_FILES: DiffFile[] = [];
const lineClasses: Record<DiffLine["kind"], string> = {
  add: "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-200",
  remove: "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-200",
  context: "text-foreground",
  hunk: "bg-muted text-muted-foreground italic",
};

function DiffFileList({ files, selected, select, selection, commentCounts }: {
  files: DiffFile[]; selected?: string; select: (path: string) => void; selection?: HunkSelection;
  commentCounts: Map<string, number>;
}) {
  return (
    <div className="w-[220px] max-w-[40%] shrink-0 overflow-y-auto border-r" aria-label={S.diffViewer.files}>
      {files.map((file) => {
        const slash = file.path.lastIndexOf("/");
        return (
          <button key={file.path} type="button" title={file.path} aria-pressed={selected === file.path}
            onClick={() => select(file.path)}
            className={"block w-full border-b px-4 py-3 text-left text-sm hover:bg-accent focus-visible:outline-ring focus-visible:outline-2 focus-visible:-outline-offset-2 " +
              (selected === file.path ? "bg-accent text-accent-foreground" : "text-foreground")}>
            {slash >= 0 && <span className="block truncate text-xs text-muted-foreground">{file.path.slice(0, slash)}</span>}
            <span className="block truncate font-medium">{file.path.slice(slash + 1)}</span>
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {selection && <span className="text-xs text-muted-foreground">{fmt(S.diffViewer.kept, {
                n: file.hunks.filter((hunk) => selection.kept.has(hunk.id)).length, total: file.hunks.length,
              })}</span>}
              {!file.binary && <>
                <Badge variant="outline" className="border-green-600/40 text-green-800 dark:text-green-200">{fmt(S.diffViewer.additions, { n: file.additions })}</Badge>
                <Badge variant="outline" className="border-red-600/40 text-red-800 dark:text-red-200">{fmt(S.diffViewer.deletions, { n: file.deletions })}</Badge>
              </>}
              {!!commentCounts.get(file.path) && <Badge variant="secondary">{commentCounts.get(file.path) === 1 ? S.diffViewer.oneComment : fmt(S.diffViewer.commentCount, { n: commentCounts.get(file.path)! })}</Badge>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DiffPane({ file, fileIndex, loading, error, selection, feedback }: {
  file?: DiffFile; fileIndex: number; loading: boolean; error: string; selection?: HunkSelection; feedback?: LineFeedback;
}) {
  const commentable = useMemo(() => file?.lines.flatMap((line, i) => line.kind === "hunk" ? [] : [i]) ?? [], [file]);
  const [focused, setFocused] = useState(commentable[0]);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const editing = feedback?.editing;
  const previousEditing = useRef(editing);
  useEffect(() => {
    if (previousEditing.current && !editing) {
      const [index, line] = previousEditing.current.split(":").map(Number);
      if (index === fileIndex) rows.current.get(line)?.focus();
    }
    previousEditing.current = editing;
  }, [editing, fileIndex]);
  return (
    <section data-testid="diff-pane" className="min-w-0 flex-1 overflow-x-auto overflow-y-auto"
      aria-label={file ? fmt(S.diffViewer.diff, { path: file.path }) : S.diffViewer.title}>
      {loading ? <p className="p-6 text-muted-foreground" role="status">{S.diffViewer.loading}</p> :
        error ? <div className="p-6" role="status"><p>{S.diffViewer.error}</p><p className="mt-2 text-muted-foreground">{error}</p></div> :
        !file ? <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <CheckCircle2 className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">{S.diffViewer.noChanges}</p>
          <p className="text-sm text-muted-foreground">{S.diffViewer.noChangesHint}</p>
        </div> : <>
          {file.wholeFile && <div className="flex items-center gap-3 bg-muted px-3 py-2">
            <HunkCheck id={file.hunks[0].id} selection={selection} />
            <span>{S.diffViewer.wholeFile}</span>
          </div>}
          {file.binary ? <p className="p-6 text-muted-foreground">{S.diffViewer.binary}</p> :
            <div className="m-0 w-max min-w-full font-mono text-xs leading-6">
              {file.lines.map((line, i) => {
                const id = `${fileIndex}:${i}`;
                const canComment = !!feedback && line.kind !== "hunk";
                const comment = feedback?.comments[id];
                return <Fragment key={i}><div data-kind={line.kind}
                  ref={(node) => { if (node) rows.current.set(i, node); else rows.current.delete(i); }}
                  role={canComment ? "button" : undefined} tabIndex={canComment ? (focused === i ? 0 : -1) : undefined}
                  aria-label={canComment ? fmt(S.diffViewer.commentLine, { n: line.newNo ?? line.oldNo ?? S.diffViewer.unnumbered, path: file.path }) : undefined}
                  aria-disabled={canComment ? feedback.saving : undefined}
                  onFocus={() => { if (canComment) setFocused(i); }}
                  onClick={() => { if (canComment && !feedback.saving) feedback.edit(id); }}
                  onKeyDown={(event) => {
                    if (!canComment) return;
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const next = commentable[Math.max(0, Math.min(commentable.length - 1, commentable.indexOf(i) + (event.key === "ArrowDown" ? 1 : -1)))];
                      rows.current.get(next)?.focus();
                    }
                    if (event.key === "Enter") { event.preventDefault(); if (!feedback.saving) feedback.edit(id); }
                  }}
                  className={"px-3 " + lineClasses[line.kind] + (canComment ? " cursor-pointer focus-visible:outline-ring focus-visible:outline-2 focus-visible:-outline-offset-2" : "")}>
                <pre className={"m-0 whitespace-pre font-mono " + (line.kind === "hunk" ? "flex items-center gap-3" : "")}>
                {line.kind === "hunk" && <HunkCheck id={file.hunks.find((hunk) => hunk.firstLine === i)!.id} selection={selection} />}
                {line.kind !== "hunk" && <>
                  {feedback && <span className="inline-block w-5 align-middle" aria-hidden="true">{comment !== undefined && <MessageSquare className="size-3" />}</span>}
                  <span className="mr-3 inline-block w-10 select-none text-right text-muted-foreground" aria-hidden="true">{line.oldNo}</span>
                  <span className="mr-3 inline-block w-10 select-none text-right text-muted-foreground" aria-hidden="true">{line.newNo}</span>
                </>}
                <span>{line.text}</span>
                </pre>
                {comment !== undefined && <span className="sr-only">{S.diffViewer.commented}</span>}
              </div>
              {feedback?.editing === id ? <CommentBox feedback={feedback} /> : comment !== undefined &&
                <p className="m-3 max-w-xl whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-sans text-sm text-muted-foreground">{comment}</p>}
              </Fragment>;
              })}
              {!file.wholeFile && file.hunks.filter((hunk) => hunk.firstLine >= file.lines.length).map((hunk) =>
                <div key={hunk.id} data-kind="hunk" className={"flex items-center gap-3 px-3 " + lineClasses.hunk}>
                  <HunkCheck id={hunk.id} selection={selection} />
                  <span>{hunk.header}</span><span className="ml-3">{S.diffViewer.hiddenHunk}</span>
                </div>)}
            </div>}
          {file.truncated && <p className="border-t p-4 text-sm text-muted-foreground">{S.diffViewer.truncated}</p>}
        </>}
    </section>
  );
}

export function DiffViewer({ taskName, files, loading = false, error = "", selection, feedback, actions, saveError = "", notice }: {
  taskName: string; files: DiffFile[]; loading?: boolean; error?: string;
  selection?: HunkSelection; actions?: ReactNode; saveError?: string;
  feedback?: LineFeedback; notice?: ReactNode;
}) {
  const sorted = useMemo(() => [...files].sort((a, b) =>
    (b.additions + b.deletions) - (a.additions + a.deletions) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), [files]);
  const [selected, select] = useState<string>();
  const file = sorted.find((item) => item.path === selected) ?? sorted[0];
  const commentCounts = new Map(files.map((item, i) => [item.path,
    Object.keys(feedback?.comments ?? {}).filter((id) => id.startsWith(`${i}:`)).length]));
  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-4 border-b p-5">
        <div className="min-w-0">
          <DialogTitle className="break-words leading-snug">{taskName}</DialogTitle>
          <DialogDescription className="mt-1">{S.diffViewer.title}</DialogDescription>
          {!!files.length && <p className="mt-1 text-sm text-muted-foreground">
            {files.length === 1 ? S.diffViewer.fileChanged : fmt(S.diffViewer.filesChanged, { n: files.length })}
          </p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions}
          <DialogClose asChild><Button type="button" variant="outline" size="sm">{S.diffViewer.close}</Button></DialogClose>
        </div>
      </header>
      {saveError && <p role="status" className="border-b px-5 py-3 text-sm text-destructive">{saveError}</p>}
      {notice}
      <div className="flex min-h-0 flex-1 flex-row">
        <DiffFileList files={sorted} selected={file?.path} select={select} selection={selection} commentCounts={commentCounts} />
        <DiffPane key={file?.path} file={file} fileIndex={file ? files.indexOf(file) : -1} loading={loading} error={error} selection={selection} feedback={feedback} />
      </div>
    </>
  );
}

export function TestBadge({ run }: { run: Run }) {
  const tests = run.reviewed?.action === "applied" ? run.reviewed.tests : undefined;
  if (!tests) return null;
  const helper = run.member === "coordinator" && !run.team ? S.coordinator.name : run.member;
  const busy = tests.state === "queued" || tests.state === "running";
  return <div className="space-y-1">
    <Badge variant="secondary">
      {busy && <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />}
      {tests.sentBack ? fmt(S.tests.sentBadge, { helper }) : busy ? S.tests.testing :
        tests.state === "passed" ? S.tests.passedBadge : tests.state === "skipped" ? S.tests.skipped : S.tests.failedBadge}
    </Badge>
    {tests.sentBack && run.testsFollowup?.waiting && <span className="text-xs text-muted-foreground">{S.conversation.waiting}</span>}
    {!busy && tests.state === "failed" && !!tests.failures?.length && <ul className="text-sm">
      {tests.failures.map((failure, i) => <li key={i}>{failure.name}{failure.file && <span className="ml-1 font-mono text-xs">{failure.file}</span>}</li>)}
    </ul>}
  </div>;
}

function TestResults({ run, saving, act, notice, saveError }: {
  run: Run; saving: boolean; act: (action: "" | "/send-back" | "/done") => void; notice: ReactNode; saveError: string;
}) {
  const tests = run.reviewed?.action === "applied" ? run.reviewed.tests : undefined;
  const [output, setOutput] = useState<string>();
  const [outputError, setOutputError] = useState("");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setOutput(undefined); setOutputError("");
    if (!expanded) return;
    const controller = new AbortController();
    void api<string>("runs/" + enc(run.runId) + "/tests/output", undefined, controller.signal, true)
      .then((text) => { if (!controller.signal.aborted) setOutput(text); })
      .catch((reason) => { if (!controller.signal.aborted) setOutputError(errorText(reason)); });
    return () => controller.abort();
  }, [expanded, run.runId, tests?.startedAt, tests?.state]);
  if (!tests) return null;
  const helper = run.member === "coordinator" && !run.team ? S.coordinator.name : run.team ? run.member : undefined;
  const busy = tests.state === "queued" || tests.state === "running";
  const failed = ["failed", "error", "interrupted"].includes(tests.state);
  return <section className="min-h-0 overflow-y-auto p-5 space-y-4" aria-label={S.tests.title}>
    <p role="status" className="flex items-center gap-2">
      {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
      {tests.state === "queued" ? S.tests.queued : tests.state === "running" ? S.tests.running :
        tests.state === "passed" ? S.tests.passed : tests.state === "skipped" ? S.tests.skipped :
        tests.note || fmt(S.tests.failed, { n: tests.failures?.length ?? 0 })}
    </p>
    {failed && <>
      {tests.failures?.length ? <ul className="space-y-2">{tests.failures.map((failure, i) =>
        <li key={i}><span>{failure.name}</span>{failure.file && <code className="ml-2 text-sm">{failure.file}</code>}</li>)}</ul> : <p>{S.tests.unparsed}</p>}
      {!!tests.changedFiles?.length && <div><h3>{S.tests.changedFiles}</h3><ul>{tests.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div>}
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer">{S.tests.output}</summary>
        {expanded && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-xs">{outputError || output || (output === undefined ? S.tests.loadingOutput : "")}</pre>}
      </details>
      <div className="flex flex-wrap gap-2">
        {helper && tests.state !== "interrupted" && !tests.sentBack && <Button disabled={saving} onClick={() => act("/send-back")}>{fmt(S.tests.sendBack, { helper })}</Button>}
        <Button variant="outline" disabled={saving} onClick={() => act("")}>{S.tests.rerun}</Button>
        <Button variant="outline" disabled={saving} onClick={() => act("/done")}>{S.tests.done}</Button>
      </div>
    </>}
    {saveError && <p role="alert">{saveError}</p>}
    {notice}
  </section>;
}

/** This component owns the open state and fetch; page polling only updates its props. */
export function ReviewChanges({ run: polledRun, small = false, actionKey, controlledOpen, onOpenChange, returnFocus }: {
  run: Run; small?: boolean; actionKey: string; controlledOpen?: boolean; onOpenChange?: (open: boolean) => void; returnFocus?: () => void;
}) {
  const [localRun, setLocalRun] = useState<Run>();
  const run = localRun ?? polledRun;
  useEffect(() => setLocalRun(undefined), [polledRun]);
  const { tell, refresh, confirm, messages } = useActions();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => { setInternalOpen(value); onOpenChange?.(value); };
  const [showChanges, setShowChanges] = useState(false);
  const tests = run.reviewed?.action === "applied" ? run.reviewed.tests : undefined;
  const previousTestState = useRef(tests?.state);
  useEffect(() => {
    if (tests?.state === "passed" && previousTestState.current !== "passed") tell(actionKey, S.tests.passedMessage, true);
    previousTestState.current = tests?.state;
  }, [tests?.state, actionKey, tell]);
  const [changes, setChanges] = useState<RunChanges>();
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [kept, setKept] = useState(new Set<string>());
  const [saving, setSaving] = useState(false);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");
  const lastHead = useRef<string>(undefined);
  const feedbackKey = actionKey + "-" + run.runId + "-feedback";
  useEffect(() => {
    if (!open) return;
    setShowChanges(false); setError(""); setSaveError(""); setChanges(undefined);
    const controller = new AbortController();
    void api<RunChanges>("runs/" + enc(run.runId) + "/changes", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          if (lastHead.current !== undefined && lastHead.current !== value.head) {
            setComments({});
            setEditing(undefined);
            if (Object.keys(comments).length) tell(feedbackKey, S.diffViewer.commentsCleared, true);
          }
          lastHead.current = value.head;
          setChanges(value);
          setKept(new Set(value.files.flatMap((file) => file.hunks.map((hunk) => hunk.id))));
        }
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => controller.abort();
  }, [open, run.runId]);

  async function save(action: "apply" | "discard") {
    if (saving || !changes) return;
    setSaving(true);
    setSaveError("");
    try {
      const updated = await api<Run>("runs/" + enc(run.runId) + "/" + action,
        action === "apply" ? { head: changes.head, hunks: [...kept] } : {});
      setComments({});
      setEditing(undefined);
      if (action === "apply") {
        setLocalRun({ ...run, ...updated });
        setShowChanges(false);
      } else setOpen(false);
      tell(actionKey, action === "apply" ? S.diffViewer.applySuccess : S.diffViewer.discardSuccess, true);
      refresh();
    } catch (reason) { setSaveError(errorText(reason)); }
    finally { setSaving(false); }
  }
  async function testAction(action: "" | "/send-back" | "/done") {
    if (saving) return;
    setSaving(true); setSaveError("");
    try {
      const result = await api<Run & FeedbackResult>("runs/" + enc(run.runId) + "/tests" + action, {});
      if (action === "/send-back") {
        const helper = run.member === "coordinator" && !run.team ? S.coordinator.name : run.member;
        tell(feedbackKey, fmt(result.delivered ? S.tests.sent : S.tests.waiting, { helper }), true);
        if (run.reviewed?.action === "applied" && tests) setLocalRun({ ...run, reviewed: { ...run.reviewed,
          tests: { ...tests, sentBack: { at: new Date().toISOString(), messageId: result.messageId, to: helper! } } } });
      } else setLocalRun({ ...run, ...result });
      refresh();
    } catch (reason) { setSaveError(errorText(reason)); }
    finally { setSaving(false); }
  }
  const helper = run.member === "coordinator" && !run.team ? "coordinator" :
    run.team && run.member ? `${run.team}/${run.member}` : undefined;
  const feedbackAllowed = run.state === "done" && run.reviewStatus === "ready" && !run.reviewed && !!helper;
  const count = Object.keys(comments).length;
  async function send() {
    if (saving || !changes || !count || !feedbackAllowed) return;
    setSaving(true);
    setSaveError("");
    try {
      const result = await api<FeedbackResult>("runs/" + enc(run.runId) + "/feedback", {
        head: changes.head, comments: Object.entries(comments).map(([line, text]) => ({ line, text })),
      });
      setComments({});
      setEditing(undefined);
      setDraft("");
      tell(feedbackKey, fmt(result.delivered ? S.diffViewer.feedbackSent : S.diffViewer.feedbackWaiting, { helper: helper! }), true);
      refresh();
    } catch (reason) { setSaveError(errorText(reason)); }
    finally { setSaving(false); }
  }
  const feedback: LineFeedback | undefined = feedbackAllowed ? {
    comments, editing, draft, saving,
    edit: (id) => { setEditing(id); setDraft(comments[id] ?? ""); },
    change: setDraft,
    cancel: () => setEditing(undefined),
    save: () => {
      if (saving || !editing || !draft.trim()) return;
      if (draft.trim().length > 2000 || (comments[editing] === undefined && count >= 100)) {
        setSaveError(S.errors.invalid_feedback);
        return;
      }
      setComments((previous) => ({ ...previous, [editing]: draft.trim() }));
      setEditing(undefined);
    },
    remove: () => {
      if (saving || !editing) return;
      setComments((previous) => { const next = { ...previous }; delete next[editing]; return next; });
      setEditing(undefined);
    },
  } : undefined;
  function decide(action: "apply" | "discard") {
    if (action === "discard" || count) confirm({
      title: action === "discard" ? S.diffViewer.discardTitle : S.diffViewer.loseCommentsTitle,
      effects: [
        ...(action === "discard" ? [{ what: S.diffViewer.discardEffect, kind: "kept" as const }] : []),
        ...(count ? [{ what: S.diffViewer.loseCommentsEffect, kind: "lost" as const }] : []),
      ],
      label: action === "discard" ? S.diffViewer.discard : S.diffViewer.apply, action: () => save(action),
    });
    else void save(action);
  }
  const editable = run.reviewStatus === "ready" && !run.reviewed;
  const selection: HunkSelection | undefined = editable && changes ? { kept, saving,
    toggle: (id, checked) => setKept((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id); else next.delete(id);
      return next;
    }),
  } : undefined;
  const total = changes?.files.reduce((sum, file) => sum + file.hunks.length, 0) ?? 0;
  const actions = editable ? <>
    {feedbackAllowed && count > 0 && <Button type="button" size="sm" disabled={saving || !changes} onClick={() => void send()}>{fmt(S.diffViewer.sendFeedback, { n: count })}</Button>}
    <span className="text-sm text-muted-foreground">{fmt(S.diffViewer.selected, { n: kept.size, total })}</span>
    <Button type="button" size="sm" disabled={!kept.size || saving} onClick={() => decide("apply")}>{S.diffViewer.apply}</Button>
    <Button type="button" variant="outline" size="sm" disabled={saving || !changes} onClick={() => decide("discard")}>{S.diffViewer.discard}</Button>
  </> : run.reviewed?.action === "applied" ?
    <span className="text-sm text-muted-foreground">{fmt(S.diffViewer.applied, { n: run.reviewed.hunks, total: run.reviewed.total })}</span> : null;

  if (!tests && run.reviewStatus !== "ready" && run.reviewStatus !== "no_changes") return null;
  return (
    <Dialog open={open} onOpenChange={(value) => {
      if (saving) return;
      if (value) { setShowChanges(false); setChanges(undefined); setError(""); setSaveError(""); setKept(new Set()); }
      setEditing(undefined);
      setOpen(value);
    }}>
      {controlledOpen === undefined && <DialogTrigger asChild>
        <Button type="button" variant="outline" size={small ? "sm" : "default"} data-testid="task-review">{S.diffViewer.button}</Button>
      </DialogTrigger>}
      <DialogContent showCloseButton={false} onCloseAutoFocus={(event) => {
        if (returnFocus) { event.preventDefault(); returnFocus(); }
      }} onEscapeKeyDown={(event) => {
        if (editing && feedbackAllowed) { event.preventDefault(); setEditing(undefined); }
      }} className="w-[90vw] max-w-5xl max-h-[90vh] p-0 overflow-hidden flex flex-col h-[80vh] gap-0 sm:max-w-5xl">
        {tests && <div className="flex shrink-0 justify-end border-b p-3"><Button size="sm" variant="outline" onClick={() => setShowChanges(!showChanges)}>{showChanges ? S.tests.showTests : S.tests.showChanges}</Button></div>}
        {tests && !showChanges ? <>
          <header className="flex shrink-0 items-start justify-between gap-4 border-b p-5">
            <div><DialogTitle>{run.task}</DialogTitle><DialogDescription>{S.tests.title}</DialogDescription></div>
            <DialogClose asChild><Button variant="outline" size="sm">{S.diffViewer.close}</Button></DialogClose>
          </header>
          <TestResults run={run} saving={saving} act={(action) => void testAction(action)} saveError={saveError}
            notice={messages[feedbackKey]?.text && <Message actionKey={feedbackKey} />} />
        </> : <DiffViewer taskName={run.task} files={changes?.files ?? EMPTY_FILES} loading={!changes && !error} error={error}
          selection={selection} feedback={feedback} actions={actions} saveError={saveError}
          notice={messages[feedbackKey]?.text && <div className="border-b px-5 py-3"><Message actionKey={feedbackKey} /></div>} />}
      </DialogContent>
    </Dialog>
  );
}
