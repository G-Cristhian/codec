import { useEffect, useId, useRef, useState } from "react";
import { S, api, enc, fmt, when } from "./lib/api";
import { Message, useActions } from "./shared";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Textarea } from "./components/ui/textarea";

export interface ConversationMessage {
  id: string;
  senderName: string;
  senderKind: "owner" | "helper" | "coordinator" | "system";
  recipientName: string;
  body: string;
  sentAt: string;
  waiting: boolean;
}

/** The conversation fields added to the project page's existing payload. */
export interface ProjectConversation {
  messages: ConversationMessage[];
  helpers: { ref: string; name: string; running: boolean }[];
  messagesError: boolean;
  cappedPairs: { key: string; a: string; b: string; limit?: number }[];
}

export function useConversationTab(messages?: ConversationMessage[]) {
  const [tab, setTab] = useState("board");
  const [unread, setUnread] = useState(0);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!messages) return;
    if (seen.current === null) {
      seen.current = new Set(messages.map((message) => message.id));
      return;
    }
    let added = 0;
    for (const message of messages) {
      if (!seen.current.has(message.id)) added++;
      seen.current.add(message.id);
    }
    if (tab === "board" && added) setUnread((count) => count + added);
  }, [messages, tab]);
  function changeTab(value: string) {
    setTab(value);
    if (value === "conversation") setUnread(0);
  }
  return { tab, changeTab, unread };
}

function renderMessages(
  messages: ConversationMessage[] | undefined,
  messagesError: boolean | undefined,
  refresh: () => void,
) {
  if (messagesError || !messages) return (
    <div className="p-4 text-sm text-destructive" role="alert">
      <p>{S.conversation.loadError}</p>
      <Button variant="link" className="h-auto p-0 text-destructive" onClick={refresh}>
        {S.conversation.retry}
      </Button>
    </div>
  );
  if (!messages.length) return <p className="p-8 text-center text-sm text-muted-foreground">{S.conversation.empty}</p>;
  return messages.map((message) => {
    const sentAt = when(message.sentAt);
    return (
      <div
        key={message.id}
        data-testid="conversation-message"
        className={"border-b border-border px-4 py-3 hover:bg-muted/30 " + (message.senderKind === "owner" ? "bg-muted/40" : "bg-background")}
      >
        <div className="flex items-baseline gap-2">
          <span title={message.senderName} className="min-w-0 truncate text-sm font-medium text-foreground">{message.senderName}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={message.sentAt} title={sentAt} className="min-w-0 truncate text-xs text-muted-foreground">{sentAt}</time>
          {message.waiting && (
            <Badge variant="outline" className="border-status-needs text-xs text-status-needs">
              {S.conversation.waiting}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]">{message.body}</p>
      </div>
    );
  });
}

const noHelpers: ProjectConversation["helpers"] = [];
export function ConversationFeed({
  name,
  messages,
  helpers = noHelpers,
  messagesError,
  cappedPairs = [],
  active,
}: Partial<ProjectConversation> & { name: string; active: boolean }) {
  const { act, pending, refresh } = useActions();
  const key = "conversation-" + name;
  const storageKey = "codec-conversation-recipient-" + name;
  const [recipient, setRecipient] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) || "all";
    } catch {
      return "all";
    }
  });
  const to = recipient === "all" || helpers.some((helper) => helper.ref === recipient)
    ? recipient : "all";
  const [body, setBody] = useState("");
  const inFlight = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pickerId = useId();
  const busy = !!pending[key];
  useEffect(() => {
    if (active) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages, active]);
  function choose(value: string) {
    setRecipient(value);
    try {
      sessionStorage.setItem(storageKey, value);
    } catch { /* Selection still lasts while mounted. */ }
  }
  async function send() {
    if (inFlight.current || !helpers.length || !body.trim()) return;
    inFlight.current = true;
    const sentBody = body;
    try {
      const sent = await act(
        key,
        () => api("projects/" + enc(name) + "/messages", { to, body: sentBody }),
        "",
      );
      if (sent) {
        setBody((current) => current === sentBody ? "" : current);
        bottom.current?.scrollIntoView({ block: "nearest" });
        textarea.current?.focus();
      }
    } finally {
      inFlight.current = false;
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background">
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="conversation-scroll"
        role="log"
        aria-label={S.conversation.title}
      >
        {renderMessages(messages, messagesError, refresh)}
        <div ref={bottom} />
      </div>
      {cappedPairs.map((pair) => {
        const resetKey = "message-limit-reset-" + pair.key;
        return (
          <div key={pair.key} className="shrink-0 border-t border-border px-3 py-2 text-sm">
            <p>{fmt(S.messageLimit.cappedPair, {
              a: pair.a === "coordinator" ? S.coordinator.name : pair.a,
              b: pair.b === "coordinator" ? S.coordinator.name : pair.b,
            })}</p>
            <Button variant="link" disabled={!!pending[resetKey]} onClick={() => void act(resetKey,
              () => api("projects/" + enc(name) + "/message-limits/reset", { pairKey: pair.key }), "") }>
              {S.messageLimit.continue}
            </Button>
            <Message actionKey={resetKey} />
          </div>
        );
      })}
      <form
        className="flex shrink-0 flex-col gap-2 border-t border-border bg-background p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {!helpers.length && <p className="text-sm text-muted-foreground">{S.conversation.noHelpers}</p>}
        <div className="flex items-center gap-2">
          <Label htmlFor={pickerId}>{S.conversation.to}</Label>
          <Select value={to} onValueChange={choose}>
            <SelectTrigger id={pickerId} className="min-w-0 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{S.conversation.all}</SelectItem>
              {helpers.map((helper) => (
                <SelectItem key={helper.ref} value={helper.ref}>
                  {helper.running ? helper.name : fmt(S.conversation.stopped, { name: helper.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            ref={textarea}
            aria-label={S.conversation.message}
            rows={2}
            className="min-h-16 max-h-28 resize-none field-sizing-content"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <Button type="submit" disabled={busy || !helpers.length || !body.trim()}>
            {S.conversation.send}
          </Button>
        </div>
        <Message actionKey={key} />
      </form>
    </div>
  );
}
