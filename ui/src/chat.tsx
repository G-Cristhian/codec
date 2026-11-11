import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Copy } from "lucide-react";
import { S, api, fmt, toolName, type PageData } from "./lib/api";
import { Button, Hint, Label, Message, Picker, useActions } from "./shared";

// Render the owner's Markdown subset as React nodes. Raw HTML remains text.
function inlineMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern =
    /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?:\*|_)([^*_\n]+)(?:\*|_)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0,
    m;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = m.index;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined)
      out.push(<strong key={key}>{inlineMarkdown(m[2])}</strong>);
    else if (m[3] !== undefined) out.push(<em key={key}>{m[3]}</em>);
    else
      out.push(
        <a
          key={key}
          href={m[5]}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          {m[4]}
        </a>,
      );
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  text.split(/^```[^\n]*\n?/m).forEach((part, i) => {
    if (i % 2) {
      blocks.push(
        <pre key={blocks.length}>
          <code>{part.replace(/\n$/, "")}</code>
        </pre>,
      );
      return;
    }
    let list: { ordered: boolean; items: string[] } | undefined,
      para: string[] = [];
    const flushList = () => {
      if (!list) return;
      const Tag = list.ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={blocks.length}>
          {list.items.map((item, j) => (
            <li key={j}>{inlineMarkdown(item)}</li>
          ))}
        </Tag>,
      );
      list = undefined;
    };
    const flush = () => {
      flushList();
      if (para.length)
        blocks.push(
          <p key={blocks.length}>
            {para.map((line, n) => (
              <Fragment key={n}>
                {n ? <br /> : null}
                {inlineMarkdown(line)}
              </Fragment>
            ))}
          </p>,
        );
      para = [];
    };
    for (const line of part.split("\n")) {
      const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
      const head = /^#{1,6}\s+(.*)$/.exec(line);
      if (!line.trim()) flush();
      else if (head) {
        flush();
        blocks.push(<h3 key={blocks.length}>{inlineMarkdown(head[1])}</h3>);
      } else if (item) {
        if (para.length) flush();
        const ordered = !item[1];
        if (list && list.ordered !== ordered) flushList();
        list ??= { ordered, items: [] };
        list.items.push(item[3]);
      } else if (list && /^\s{2,}\S/.test(line))
        list.items[list.items.length - 1] += " " + line.trim();
      else {
        flushList();
        para.push(line);
      }
    }
    flush();
  });
  return <>{blocks}</>;
}
function clock(iso?: string) {
  const at = new Date(iso || "");
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
export function ChatPage({ data }: { data: PageData }) {
  const v = data.chat!;
  const { act, pending, tell } = useActions();
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null),
    bottom = useRef(true);
  const tool = toolName(v.tool),
    me = data.setup.profileName?.trim().split(/\s+/)[0] || S.chat.you;
  const models = v.models?.[v.tool] || [];
  const choices =
    v.model && !models.some((m) => m.id === v.model)
      ? [...models, { id: v.model, label: v.model }]
      : models;
  // A poll can update any message (including a partial reply) without replacing
  // the log or composer. Follow output only while the reader is at its bottom.
  useLayoutEffect(() => {
    if (bottom.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [v.messages, v.busy]);
  const submit = () => {
    const text = draft.trim();
    if (!text || v.busy || pending.chat) return;
    void act(
      "chat",
      async () => {
        await api("chat", { text });
        setDraft((current) => (current === draft ? "" : current));
      },
      "",
    );
  };
  return (
    <div className="chat-page">
      <div
        className="chat-log"
        ref={log}
        data-testid="chat-log"
        aria-live="polite"
        onScroll={(e) => {
          const n = e.currentTarget;
          bottom.current = n.scrollTop + n.clientHeight >= n.scrollHeight - 20;
        }}
      >
        {!v.messages.length && !v.busy && (
          <div className="chat-empty">
            <h2>{S.chat.empty}</h2>
            <p>{S.chat.intro}</p>
          </div>
        )}
        {v.messages.map((m, i) => (
          <article
            className={"chat-message " + m.role}
            data-testid="chat-message"
            data-key={m.role}
            key={i}
          >
            <div className="chat-meta">
              <strong>{m.role === "user" ? me : tool}</strong>
              {m.model && (
                <span className="hint">
                  {models.find((model) => model.id === m.model)?.label ||
                    m.model}
                </span>
              )}
              {m.at && <time dateTime={m.at}>{clock(m.at)}</time>}
              {m.role === "assistant" && (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="chat-copy"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(m.text);
                      tell("chat", S.common.copied, true);
                    } catch {
                      tell("chat", S.common.copyFailed);
                    }
                  }}
                >
                  <Copy aria-hidden="true" />
                  {S.chat.copy}
                </Button>
              )}
            </div>
            <div className="chat-body">
              {m.role === "assistant" ? (
                <Markdown text={m.text} />
              ) : (
                <p>{m.text}</p>
              )}
            </div>
          </article>
        ))}
        {v.busy && (
          <div
            className="chat-message"
            data-testid="chat-thinking"
            aria-label={fmt(S.chat.thinking, { tool })}
          >
            <strong>{tool}</strong>
            <p className="hint">{fmt(S.chat.thinking, { tool })}</p>
          </div>
        )}
      </div>
      <form
        className="chat-composer"
        data-testid="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Label htmlFor="chat-text">{S.chat.message}</Label>
        <textarea
          id="chat-text"
          data-testid="chat-text"
          rows={2}
          maxLength={20000}
          value={draft}
          placeholder={fmt(S.chat.placeholder, { tool })}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-controls">
          <div title={S.chat.switchHint}>
            <Picker
              id="chat-tool"
              label={S.chat.provider}
              value={v.tool}
              disabled={pending.chat}
              options={["claude", "codex"].map((t) => ({
                value: t,
                label: toolName(t),
              }))}
              onChange={(tool) =>
                void act("chat", () => api("chat/new", { tool }), "")
              }
            />
          </div>
          <div title={S.chat.modelHint}>
            <Picker
              id="chat-model"
              label={S.chat.model}
              value={v.model || "__default"}
              disabled={pending.chat}
              options={[
                { value: "__default", dataKey: "", label: S.chat.defaultModel },
                ...choices.map((m) => ({ value: m.id, label: m.label })),
              ]}
              onChange={(model) =>
                void act(
                  "chat",
                  () =>
                    api("chat/model", {
                      model: model === "__default" ? "" : model,
                    }),
                  "",
                )
              }
            />
          </div>
          <Button
            type="button"
            variant="outline"
            data-testid="chat-new"
            disabled={pending.chat || (!v.messages.length && !v.busy)}
            onClick={() => void act("chat", () => api("chat/new", {}), "")}
          >
            {S.chat.newChat}
          </Button>
          <Button
            type="submit"
            data-testid="chat-send"
            disabled={v.busy || pending.chat}
          >
            {S.chat.send}
          </Button>
        </div>
        <Hint>{S.chat.enterHint}</Hint>
        <Message actionKey="chat" />
      </form>
    </div>
  );
}
