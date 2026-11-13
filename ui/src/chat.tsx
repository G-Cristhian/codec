import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  Copy,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { S, api, enc, fmt, toolName, projectTagText, type PageData } from "./lib/api";
import { Button, Input, Message, Picker, useActions } from "./shared";
import { go } from "./pages";

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
const MAX_MESSAGE = 20000;

function ChatList({ data }: { data: PageData }) {
  const v = data.chat!;
  const { act, pending } = useActions();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const chats = (v.chats ?? []).filter(
    (c) => !q || c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q),
  );
  return (
    <aside className="chat-list" aria-label={S.chat.chats}>
      <Button
        data-testid="chat-new"
        disabled={pending.chat || (!v.messages.length && !v.busy)}
        onClick={() =>
          void act(
            "chat",
            async () => {
              const next = await api<{ id?: string }>("chat/new", {});
              if (next.id) go("#/chat/" + enc(next.id));
            },
            "",
          )
        }
      >
        <Plus aria-hidden="true" />
        {S.chat.newChat}
      </Button>
      <label className="chat-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          placeholder={S.chat.search}
          aria-label={S.chat.search}
          data-testid="chat-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <h2 className="chat-list-head">{S.chat.recent}</h2>
      {chats.length ? (
        <nav className="chat-list-items">
          {chats.map((c) => (
            <a
              key={c.id}
              href={"#/chat/" + enc(c.id)}
              data-testid="chat-item"
              data-key={c.id}
              aria-current={c.id === v.id ? "page" : undefined}
              title={c.title}
            >
              <MessageSquare aria-hidden="true" />
              <span>{c.title}</span>
              {c.busy && <i className="dot pulse working-dot" aria-hidden="true" />}
            </a>
          ))}
        </nav>
      ) : (
        <p className="hint chat-list-empty">{q ? S.chat.noMatches : S.chat.noChats}</p>
      )}
    </aside>
  );
}

function ChatHeader({ data }: { data: PageData }) {
  const v = data.chat!;
  const { act, confirm } = useActions();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(v.title ?? "");
  const classes = data.home.classes ?? [];
  const saved = v.messages.length > 0 && !!v.id;
  const tagValue = v.area === "class" ? "class:" + v.className : v.area ?? "";
  const tagText = projectTagText(v);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".chat-menu")) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  function renameChat() {
    setMenu(false);
    setTitle(v.title ?? "");
    setRenaming(true);
  }

  function removeChat() {
    setMenu(false);
    confirm({
      title: fmt(S.chat.removeConfirm, { title: v.title ?? "" }),
      effects: [],
      label: S.chat.remove,
      action: async () => {
        await api("chat/" + enc(v.id!) + "/remove", {});
        go("#/chat");
      },
    });
  }

  return (
    <header className="chat-header">
      {renaming && v.id ? (
        <form
          className="chat-rename"
          onSubmit={(e) => {
            e.preventDefault();
            void act("chat", () => api("chat/" + enc(v.id!) + "/rename", { title }), "").then(
              (ok) => ok && setRenaming(false),
            );
          }}
        >
          <Input
            autoFocus
            aria-label={S.chat.renameLabel}
            data-testid="chat-title-input"
            maxLength={80}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
          />
          <Button type="submit" size="sm" data-testid="chat-title-save">
            {S.chat.save}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
            {S.common.cancel}
          </Button>
        </form>
      ) : (
        <h1 className="chat-title" data-testid="chat-title">
          {saved ? v.title : S.chat.newChat}
        </h1>
      )}
      {saved && !renaming && (
        <label className={"chat-tag" + (v.area ? " set" : "")} title={S.chat.tagChat}>
          <Folder aria-hidden="true" />
          <span className="sr-only">{S.chat.tagChat}</span>
          <span aria-hidden="true">{tagText || S.home.untagged}</span>
          <select
            data-testid="chat-tag"
            value={tagValue}
            onChange={(e) => {
              const t = e.target.value;
              const body = t.startsWith("class:") ? { area: "class", className: t.slice(6) } : { area: t };
              void act("chat", () => api("chat/" + enc(v.id!) + "/tag", body), "");
            }}
          >
            <option value="">{v.area ? S.home.clearTag : S.home.untagged}</option>
            {classes.map((c) => (
              <option key={c} value={"class:" + c}>
                {c}
              </option>
            ))}
            {v.area === "class" && v.className && !classes.includes(v.className) && (
              <option value={tagValue}>{v.className}</option>
            )}
            <option value="work">{S.tags.work}</option>
            <option value="personal">{S.tags.personal}</option>
          </select>
        </label>
      )}
      {saved && (
        <div className="chat-menu">
          <Button
            variant="ghost"
            size="sm"
            aria-label={S.chat.more}
            title={S.chat.more}
            aria-expanded={menu}
            data-testid="chat-more"
            onClick={() => setMenu((m) => !m)}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
          {menu && (
            <div className="chat-menu-items" role="menu">
              <button
                role="menuitem"
                data-testid="chat-rename"
                onClick={renameChat}
              >
                <Pencil aria-hidden="true" />
                {S.chat.rename}
              </button>
              <button
                role="menuitem"
                className="danger"
                data-testid="chat-remove"
                onClick={removeChat}
              >
                <Trash2 aria-hidden="true" />
                {S.chat.remove}
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

export function ChatPage({ data }: { data: PageData }) {
  const v = data.chat!;
  const { act, pending, tell } = useActions();
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null),
    bottom = useRef(true),
    file = useRef<HTMLInputElement>(null);
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
        await api("chat", v.id ? { text, id: v.id } : { text });
        setDraft((current) => (current === draft ? "" : current));
      },
      "",
    );
  };
  const attach = async (picked?: File) => {
    if (!picked) return;
    if (picked.size > MAX_MESSAGE) return tell("chat", S.chat.attachTooBig);
    const text = await picked.text();
    if (/\u0000/.test(text)) return tell("chat", S.chat.attachUnreadable);
    setDraft((d) => {
      const next = (d.trim() ? d.trimEnd() + "\n\n" : "") + "```" + picked.name + "\n" + text.replace(/\n$/, "") + "\n```\n";
      if (next.length > MAX_MESSAGE) {
        tell("chat", S.chat.attachTooBig);
        return d;
      }
      tell("chat", "");
      return next;
    });
  };
  async function copyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      tell("chat", S.common.copied, true);
    } catch {
      tell("chat", S.common.copyFailed);
    }
  }

  return (
    <div className="chat-page">
      <ChatList data={data} />
      <section className="chat-pane">
        <ChatHeader key={v.id} data={data} />
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
            </div>
          )}
          {v.messages.map((m, i) => (
            <article
              className={"chat-message " + m.role}
              data-testid="chat-message"
              data-key={m.role}
              key={i}
            >
              {m.role === "user" ? (
                <>
                  <div className="chat-meta">
                    <span className="sr-only">{me}</span>
                    {m.at && <time dateTime={m.at}>{clock(m.at)}</time>}
                  </div>
                  <div className="chat-bubble chat-body">
                    <p>{m.text}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="chat-meta">
                    <strong>{tool}</strong>
                    {m.at && <time dateTime={m.at}>{clock(m.at)}</time>}
                    {m.model && (
                      <span className="hint">
                        {models.find((model) => model.id === m.model)?.label || m.model}
                      </span>
                    )}
                  </div>
                  <div className="chat-body">
                    {m.role === "assistant" ? <Markdown text={m.text} /> : <p>{m.text}</p>}
                  </div>
                  {m.role === "assistant" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="chat-copy"
                      data-testid="chat-copy"
                      onClick={() => void copyMessage(m.text)}
                    >
                      <Copy aria-hidden="true" />
                      {S.chat.copy}
                    </Button>
                  )}
                </>
              )}
            </article>
          ))}
          {v.busy && (
            <div
              className="chat-message"
              data-testid="chat-thinking"
              aria-label={fmt(S.chat.thinking, { tool })}
            >
              <div className="chat-meta">
                <strong>{tool}</strong>
              </div>
              <p className="hint chat-typing">{fmt(S.chat.thinking, { tool })}</p>
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
          <label htmlFor="chat-text" className="sr-only">
            {S.chat.message}
          </label>
          <textarea
            id="chat-text"
            data-testid="chat-text"
            rows={1}
            maxLength={MAX_MESSAGE}
            value={draft}
            placeholder={fmt(S.chat.placeholder, { tool })}
            title={S.chat.enterHint}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-controls">
            <input
              ref={file}
              type="file"
              hidden
              data-testid="chat-file"
              onChange={(e) => {
                void attach(e.currentTarget.files?.[0]);
                e.currentTarget.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="chat-attach"
              aria-label={S.chat.attach}
              title={S.chat.attach}
              data-testid="chat-attach"
              onClick={() => file.current?.click()}
            >
              <Plus aria-hidden="true" />
            </Button>
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
                onChange={(next) =>
                  void act(
                    "chat",
                    async () => {
                      const view = await api<{ id?: string }>("chat/new", { tool: next });
                      if (view.id && view.id !== v.id) go("#/chat/" + enc(view.id));
                    },
                    "",
                  )
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
                    () => api("chat/model", { model: model === "__default" ? "" : model }),
                    "",
                  )
                }
              />
            </div>
            <Button
              type="submit"
              size="icon"
              className="chat-send"
              aria-label={S.chat.send}
              title={S.chat.send}
              data-testid="chat-send"
              disabled={v.busy || pending.chat || !draft.trim()}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          </div>
          <Message actionKey="chat" />
        </form>
      </section>
    </div>
  );
}
