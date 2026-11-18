import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";
import { S, api, enc, errorText, fmt, type DiffFile, type DiffLine, type Run, type RunChanges } from "./lib/api";
import { CheckRow, useActions } from "./shared";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./components/ui/dialog";

interface HunkSelection {
  kept: Set<string>;
  toggle: (id: string, checked: boolean) => void;
  saving: boolean;
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

function DiffFileList({ files, selected, select, selection }: {
  files: DiffFile[]; selected?: string; select: (path: string) => void; selection?: HunkSelection;
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
            <span className="mt-1 flex items-center gap-1">
              {selection && <span className="text-xs text-muted-foreground">{fmt(S.diffViewer.kept, {
                n: file.hunks.filter((hunk) => selection.kept.has(hunk.id)).length, total: file.hunks.length,
              })}</span>}
              {!file.binary && <>
                <Badge variant="outline" className="border-green-600/40 text-green-800 dark:text-green-200">{fmt(S.diffViewer.additions, { n: file.additions })}</Badge>
                <Badge variant="outline" className="border-red-600/40 text-red-800 dark:text-red-200">{fmt(S.diffViewer.deletions, { n: file.deletions })}</Badge>
              </>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DiffPane({ file, loading, error, selection }: { file?: DiffFile; loading: boolean; error: string; selection?: HunkSelection }) {
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
            <pre className="m-0 w-max min-w-full whitespace-pre font-mono text-xs leading-6">
              {file.lines.map((line, i) => <div key={i} data-kind={line.kind} className={"px-3 " + lineClasses[line.kind] + (line.kind === "hunk" ? " flex items-center gap-3" : "")}>
                {line.kind === "hunk" && <HunkCheck id={file.hunks.find((hunk) => hunk.firstLine === i)!.id} selection={selection} />}
                {line.kind !== "hunk" && <>
                  <span className="mr-3 inline-block w-10 select-none text-right text-muted-foreground" aria-hidden="true">{line.oldNo}</span>
                  <span className="mr-3 inline-block w-10 select-none text-right text-muted-foreground" aria-hidden="true">{line.newNo}</span>
                </>}
                <span>{line.text}</span>
              </div>)}
              {!file.wholeFile && file.hunks.filter((hunk) => hunk.firstLine >= file.lines.length).map((hunk) =>
                <div key={hunk.id} data-kind="hunk" className={"flex items-center gap-3 px-3 " + lineClasses.hunk}>
                  <HunkCheck id={hunk.id} selection={selection} />
                  <span>{hunk.header}</span><span className="ml-3">{S.diffViewer.hiddenHunk}</span>
                </div>)}
            </pre>}
          {file.truncated && <p className="border-t p-4 text-sm text-muted-foreground">{S.diffViewer.truncated}</p>}
        </>}
    </section>
  );
}

export function DiffViewer({ taskName, files, loading = false, error = "", selection, actions, saveError = "" }: {
  taskName: string; files: DiffFile[]; loading?: boolean; error?: string;
  selection?: HunkSelection; actions?: ReactNode; saveError?: string;
}) {
  const sorted = useMemo(() => [...files].sort((a, b) =>
    (b.additions + b.deletions) - (a.additions + a.deletions) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), [files]);
  const [selected, select] = useState<string>();
  const file = sorted.find((item) => item.path === selected) ?? sorted[0];
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
      <div className="flex min-h-0 flex-1 flex-row">
        <DiffFileList files={sorted} selected={file?.path} select={select} selection={selection} />
        <DiffPane key={file?.path} file={file} loading={loading} error={error} selection={selection} />
      </div>
    </>
  );
}

/** This component owns the open state and fetch; page polling only updates its props. */
export function ReviewChanges({ run, small = false, actionKey }: { run: Run; small?: boolean; actionKey: string }) {
  const { tell, refresh, confirm } = useActions();
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<RunChanges>();
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [kept, setKept] = useState(new Set<string>());
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<RunChanges>("runs/" + enc(run.runId) + "/changes", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
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
      await api("runs/" + enc(run.runId) + "/" + action,
        action === "apply" ? { head: changes.head, hunks: [...kept] } : {});
      setOpen(false);
      tell(actionKey, action === "apply" ? S.diffViewer.applySuccess : S.diffViewer.discardSuccess, true);
      refresh();
    } catch (reason) { setSaveError(errorText(reason)); }
    finally { setSaving(false); }
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
    <span className="text-sm text-muted-foreground">{fmt(S.diffViewer.selected, { n: kept.size, total })}</span>
    <Button type="button" size="sm" disabled={!kept.size || saving} onClick={() => void save("apply")}>{S.diffViewer.apply}</Button>
    <Button type="button" variant="outline" size="sm" disabled={saving || !changes} onClick={() => confirm({
      title: S.diffViewer.discardTitle, effects: [{ what: S.diffViewer.discardEffect, kind: "kept" }],
      label: S.diffViewer.discard, action: () => save("discard"),
    })}>{S.diffViewer.discard}</Button>
  </> : run.reviewed?.action === "applied" ?
    <span className="text-sm text-muted-foreground">{fmt(S.diffViewer.applied, { n: run.reviewed.hunks, total: run.reviewed.total })}</span> : null;

  if (run.reviewStatus !== "ready" && run.reviewStatus !== "no_changes") return null;
  return (
    <Dialog open={open} onOpenChange={(value) => {
      if (saving) return;
      if (value) { setChanges(undefined); setError(""); setSaveError(""); setKept(new Set()); }
      setOpen(value);
    }}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size={small ? "sm" : "default"} data-testid="task-review">{S.diffViewer.button}</Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="w-[90vw] max-w-5xl max-h-[90vh] p-0 overflow-hidden flex flex-col h-[80vh] gap-0 sm:max-w-5xl">
        <DiffViewer taskName={run.task} files={changes?.files ?? EMPTY_FILES} loading={!changes && !error} error={error} selection={selection} actions={actions} saveError={saveError} />
      </DialogContent>
    </Dialog>
  );
}
