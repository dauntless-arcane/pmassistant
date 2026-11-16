import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const uuid = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

const STORAGE_KEY = "pm_assistant_conversations_v1";
const MAX_STORED_CONVERSATIONS = 30;
const MAX_HISTORY_TURNS = 6;

const STEPS = [
  { key: "received", label: "Received request" },
  { key: "routed", label: "Routing to an agent" },
  { key: "running", label: "Running agent" },
  { key: "done", label: "Finalizing response" },
];

function stepIndexForStatus(status) {
  if (!status || status === "received") return 0;
  if (status === "pending") return 2; // routed + running are both "in flight"
  if (status === "done") return 4;
  if (status === "error") return 2;
  return 0;
}

function titleFromMessage(text) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

// Poll timers/abort controllers live in refs, so a "pending"/"received" entry
// loaded from a previous browser session has no way to ever resolve — mark it
// interrupted instead of leaving its spinner stuck forever.
function sanitizeConversations(parsed) {
  if (!Array.isArray(parsed)) return [];
  const now = Date.now();
  return parsed.map((c) => ({
    ...c,
    log: (c.log || []).map((e) =>
      e.status === "pending" || e.status === "received"
        ? { ...e, status: "error", error: "Interrupted — please retry.", finishedAt: now, expanded: false }
        : e
    ),
  }));
}

function loadConversations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return sanitizeConversations(parsed);
  } catch {
    return [];
  }
}

export default function App() {
  const [conversations, setConversations] = useState(loadConversations);
  const [activeId, setActiveId] = useState(() => {
    const initial = loadConversations();
    return initial[0]?.id || uuid();
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [tools, setTools] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pollTimers = useRef({}); // localId -> interval
  const abortControllers = useRef({}); // localId -> AbortController
  const bottomRef = useRef(null);
  const tickRef = useRef(null);

  const activeConversation = conversations.find((c) => c.id === activeId) || null;
  const log = activeConversation?.log || [];
  const hasActive = log.some((e) => e.status === "received" || e.status === "pending");
  const activeEntry = [...log].reverse().find((e) => e.status === "received" || e.status === "pending") || null;

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(
          [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_STORED_CONVERSATIONS)
        )
      );
    } catch {
      // localStorage full/unavailable — conversation history just won't persist across reloads.
    }
  }, [conversations]);

  useEffect(() => {
    if (hasActive && !tickRef.current) {
      tickRef.current = setInterval(() => setNow(Date.now()), 500);
    } else if (!hasActive && tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [hasActive]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeId, log.length, log.map((e) => e.status).join(",")]);

  useEffect(() => {
    return () => Object.values(pollTimers.current).forEach(clearInterval);
  }, []);

  useEffect(() => {
    fetch("/api/agents")
      .then((res) => res.json())
      .then((data) => setAgents(Array.isArray(data.agents) ? data.agents : []))
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    fetch("/api/tools")
      .then((res) => res.json())
      .then((data) => setTools(Array.isArray(data.tools) ? data.tools : []))
      .catch(() => setTools([]));
  }, []);

  function updateEntryIn(conversationId, localId, patch) {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? { ...c, updatedAt: Date.now(), log: c.log.map((e) => (e.localId === localId ? { ...e, ...patch } : e)) }
          : c
      )
    );
  }

  // Marks an entry finished and auto-collapses its thinking timeline, mirroring
  // how Claude collapses a thinking block once the answer is ready.
  function finishEntryIn(conversationId, localId, patch) {
    updateEntryIn(conversationId, localId, { ...patch, finishedAt: Date.now(), expanded: false });
  }

  function toggleExpanded(localId) {
    updateEntryIn(activeId, localId, {
      expanded: !log.find((e) => e.localId === localId)?.expanded,
    });
  }

  function startNewChat() {
    setActiveId(uuid());
    setMessage("");
    setSelectedAgentId(null);
    setSidebarOpen(false);
  }

  function selectConversation(id) {
    setActiveId(id);
    setSidebarOpen(false);
  }

  function renameConversation(id, title) {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }

  function deleteConversation(id) {
    const target = conversations.find((c) => c.id === id);
    target?.log.forEach((entry) => {
      if (pollTimers.current[entry.localId]) {
        clearInterval(pollTimers.current[entry.localId]);
        delete pollTimers.current[entry.localId];
      }
      if (abortControllers.current[entry.localId]) {
        abortControllers.current[entry.localId].abort();
        delete abortControllers.current[entry.localId];
      }
    });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === activeId) {
      setActiveId(uuid());
    }
  }

  // Stops the currently running turn: aborts the /api/ask call if it's still
  // in flight, or stops polling if it's already dispatched to an agent.
  // There's no server-side cancel (see FLOW.md) — this only stops the UI
  // from waiting on it.
  function stopActive() {
    if (!activeEntry) return;
    const { localId } = activeEntry;

    if (abortControllers.current[localId]) {
      abortControllers.current[localId].abort();
      delete abortControllers.current[localId];
    }
    if (pollTimers.current[localId]) {
      clearInterval(pollTimers.current[localId]);
      delete pollTimers.current[localId];
    }

    finishEntryIn(activeId, localId, { status: "error", error: "Stopped." });
    setBusy(false);
  }

  async function submit(e) {
    e.preventDefault();
    if (!message.trim() || busy || activeEntry) return;

    setBusy(true);
    const conversationId = activeId;
    const text = message.trim();
    setMessage("");

    // History is everything answered so far in *this* conversation, oldest first.
    const history = (conversations.find((c) => c.id === conversationId)?.log || [])
      .filter((e) => e.status === "done" && e.result)
      .slice(-MAX_HISTORY_TURNS)
      .map((e) => ({ message: e.message, result: e.result }));

    const localId = uuid();
    const entry = {
      localId,
      message: text,
      agentName: null,
      status: "received",
      result: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      expanded: true,
    };

    setConversations((prev) => {
      const exists = prev.some((c) => c.id === conversationId);
      const now = Date.now();
      if (exists) {
        return prev.map((c) =>
          c.id === conversationId ? { ...c, updatedAt: now, log: [...c.log, entry] } : c
        );
      }
      return [
        { id: conversationId, title: titleFromMessage(text), createdAt: now, updatedAt: now, log: [entry] },
        ...prev,
      ];
    });

    const controller = new AbortController();
    abortControllers.current[localId] = controller;

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history, agentId: selectedAgentId }),
        signal: controller.signal,
      });
      delete abortControllers.current[localId];
      const data = await res.json();

      if (!res.ok || data.status === "no_match") {
        finishEntryIn(conversationId, localId, {
          status: "error",
          error: data.error || "No automation matched this request.",
        });
        setBusy(false);
        return;
      }

      updateEntryIn(conversationId, localId, { agentName: data.agentName, status: "pending" });
      pollStatus(conversationId, localId, data.requestId);
      setBusy(false); // unblock input — polling continues independently in the background
    } catch (err) {
      delete abortControllers.current[localId];
      if (err.name === "AbortError") {
        // Stopped by the user — stopActive() already updated this entry.
        setBusy(false);
        return;
      }
      finishEntryIn(conversationId, localId, { status: "error", error: String(err) });
      setBusy(false);
    }
  }

  function downloadChat() {
    if (!activeConversation || log.length === 0) return;

    const lines = [`# ${activeConversation.title || "Chat"}`, ""];
    log.forEach((entry) => {
      lines.push("## You", entry.message, "");
      if (entry.status === "done" && entry.result) {
        lines.push(`## Assistant${entry.agentName ? ` (${entry.agentName})` : ""}`, entry.result, "");
      } else if (entry.status === "error" && entry.error) {
        lines.push("## Assistant", `_Error: ${entry.error}_`, "");
      }
    });

    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const safeTitle =
      (activeConversation.title || "chat")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_ ]/g, "")
        .replace(/\s+/g, "-") || "chat";

    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeTitle}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function pollStatus(conversationId, localId, requestId) {
    let attempts = 0;
    const MAX_ATTEMPTS = 400; // ~10 minutes at 1.5s intervals
    const interval = setInterval(async () => {
      if (++attempts > MAX_ATTEMPTS) {
        clearInterval(interval);
        delete pollTimers.current[localId];
        finishEntryIn(conversationId, localId, { status: "error", error: "Timed out waiting for agent response." });
        return;
      }
      try {
        const res = await fetch(`/api/status/${requestId}`);
        const data = await res.json();
        if (data.status === "done" || data.status === "error") {
          clearInterval(interval);
          delete pollTimers.current[localId];
          finishEntryIn(conversationId, localId, { status: data.status, result: data.result, error: data.error });
        }
      } catch (err) {
        clearInterval(interval);
        delete pollTimers.current[localId];
        // Don't overwrite a successfully completed entry with a transient polling error
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  log: c.log.map((entry) =>
                    entry.localId === localId && entry.status !== "done"
                      ? { ...entry, status: "error", error: String(err), finishedAt: Date.now(), expanded: false }
                      : entry
                  ),
                }
              : c
          )
        );
      }
    }, 1500);
    pollTimers.current[localId] = interval;
  }

  return (
    <div className="layout">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        onSelect={selectConversation}
        onNew={startNewChat}
        onDelete={deleteConversation}
        onRename={renameConversation}
        onClose={() => setSidebarOpen(false)}
      />

      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      <div className="app">
        <button
          type="button"
          className="mobile-menu-toggle"
          aria-label="Open conversations"
          title="Conversations"
          onClick={() => setSidebarOpen(true)}
        >
          <MenuIcon />
        </button>

        <ToolsMenu tools={tools} />

        {log.length > 0 && (
          <div className="chat-toolbar">
            <button type="button" className="chat-toolbar__download" onClick={downloadChat} title="Download chat">
              <DownloadIcon />
              <span>Download chat</span>
            </button>
          </div>
        )}

        <div className="thread">
          {log.length === 0 && (
            <div className="empty">
              <p>Describe what you need done — I'll route it to the right agent.</p>
            </div>
          )}

          {log.map((entry) => (
            <Turn key={entry.localId} entry={entry} now={now} onToggle={() => toggleExpanded(entry.localId)} />
          ))}
          <div ref={bottomRef} />
        </div>

        <form className="composer" onSubmit={submit}>
          <AgentPicker agents={agents} selectedId={selectedAgentId} onSelect={setSelectedAgentId} />
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              selectedAgentId
                ? `Message ${agents.find((a) => a.id === selectedAgentId)?.name || "agent"} directly…`
                : "Message PM Assistant…"
            }
            autoFocus
          />
          {activeEntry ? (
            <button
              type="button"
              className="composer__send is-stop"
              aria-label="Stop"
              title="Stop"
              onClick={stopActive}
            >
              <StopIcon />
            </button>
          ) : (
            // type="button" (not "submit") on purpose: this element sits in the same
            // JSX slot as the stop button above, so React reuses one DOM node across
            // both branches instead of remounting. If this were type="submit", clicking
            // Stop would flip the shared node's type to "submit" via React's re-render
            // *before* the browser finishes that same click's default action — causing
            // the click meant to stop the request to also submit the form.
            <button type="button" className="composer__send" disabled={!message.trim()} aria-label="Send" onClick={submit}>
              <ArrowIcon />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function Sidebar({ conversations, activeId, open, onSelect, onNew, onDelete, onRename, onClose }) {
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const [editingId, setEditingId] = useState(null);
  const [editingValue, setEditingValue] = useState("");

  function startEdit(c) {
    setEditingId(c.id);
    setEditingValue(c.title || "");
  }

  function commitEdit() {
    if (editingId) onRename(editingId, editingValue.trim() || "New chat");
    setEditingId(null);
  }

  return (
    <aside className={"sidebar" + (open ? " is-open" : "")}>
      <div className="sidebar__brand">
        <span className="sidebar__brand-dot" />
        <span className="sidebar__brand-text">PM Assistant</span>
        <button type="button" className="sidebar__close" aria-label="Close conversations" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="sidebar__list">
        {sorted.map((c) => (
          <div
            key={c.id}
            className={"sidebar__item" + (c.id === activeId ? " is-active" : "")}
            onClick={() => editingId !== c.id && onSelect(c.id)}
          >
            {editingId === c.id ? (
              <input
                className="sidebar__title-input"
                value={editingValue}
                autoFocus
                onChange={(e) => setEditingValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <span
                className="sidebar__title"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startEdit(c);
                }}
              >
                {c.title || "New chat"}
              </span>
            )}

            {editingId !== c.id && (
              <button
                type="button"
                className="sidebar__edit"
                aria-label="Rename conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  startEdit(c);
                }}
              >
                <EditIcon />
              </button>
            )}
            <button
              type="button"
              className="sidebar__delete"
              aria-label="Delete conversation"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
            >
              <TrashIcon />
            </button>
          </div>
        ))}
        {sorted.length === 0 && <div className="sidebar__empty">No conversations yet</div>}
      </div>

      <button type="button" className="sidebar__new" aria-label="New chat" title="New chat" onClick={onNew}>
        <PlusIcon />
      </button>
    </aside>
  );
}

function ToolsMenu({ tools }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  function openTool(tool) {
    window.open(tool.url, "_blank", "noopener,noreferrer");
    setOpen(false);
  }

  return (
    <div className="tools-menu" ref={rootRef}>
      <button
        type="button"
        className="tools-menu__trigger"
        onClick={() => setOpen((o) => !o)}
        title="Tools & artifacts"
      >
        <GridIcon />
      </button>

      {open && (
        <div className="tools-menu__menu">
          <div className="tools-menu__title">Tools & artifacts</div>
          {tools.length === 0 && <div className="tools-menu__empty">No tools registered yet</div>}
          {tools.map((t) => (
            <button type="button" key={t.id} className="tools-menu__option" onClick={() => openTool(t)}>
              <div className="tools-menu__option-name">{t.name}</div>
              {t.description && <div className="tools-menu__option-desc">{t.description}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentPicker({ agents, selectedId, onSelect }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = agents.find((a) => a.id === selectedId) || null;

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div className="agent-picker" ref={rootRef}>
      <button
        type="button"
        className={"agent-picker__trigger" + (selected ? " is-selected" : "")}
        onClick={() => setOpen((o) => !o)}
        title={selected ? `Sending directly to ${selected.name}` : "Auto — let the router pick an agent"}
      >
        <PlugIcon />
        <span className="agent-picker__trigger-label">{selected ? selected.name : "Auto"}</span>
      </button>

      {open && (
        <div className="agent-picker__menu">
          <button
            type="button"
            className={"agent-picker__option" + (!selectedId ? " is-active" : "")}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
          >
            <div className="agent-picker__option-name">Auto</div>
            <div className="agent-picker__option-desc">Let the router pick the best-matching agent</div>
          </button>
          {agents.map((a) => (
            <button
              type="button"
              key={a.id}
              className={"agent-picker__option" + (selectedId === a.id ? " is-active" : "")}
              onClick={() => {
                onSelect(a.id);
                setOpen(false);
              }}
            >
              <div className="agent-picker__option-name">{a.name}</div>
              <div className="agent-picker__option-desc">{a.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Turn({ entry, now, onToggle }) {
  const active = entry.status === "received" || entry.status === "pending";
  const elapsedMs = (entry.finishedAt || now) - entry.startedAt;
  const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));

  return (
    <div className="turn">
      <div className="bubble bubble--user">{entry.message}</div>

      <div className="assistant">
        <ThinkingBlock entry={entry} active={active} elapsedSec={elapsedSec} onToggle={onToggle} />

        {entry.status === "done" && (
          <>
            <div className="bubble bubble--assistant">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.result}</ReactMarkdown>
            </div>
            <div className="bubble-actions">
              <CopyButton text={entry.result} />
            </div>
          </>
        )}
        {entry.status === "error" && (
          <div className="bubble bubble--error">{entry.error}</div>
        )}
      </div>
    </div>
  );
}

function ThinkingBlock({ entry, active, elapsedSec, onToggle }) {
  const stepIndex = stepIndexForStatus(entry.status);
  const isError = entry.status === "error";

  let summary;
  if (active) {
    summary = entry.agentName ? `Running ${entry.agentName}…` : "Thinking…";
  } else if (isError) {
    summary = `Stopped after ${elapsedSec}s`;
  } else {
    summary = `Thought for ${elapsedSec}s`;
  }

  return (
    <div className={"thinking" + (active ? " is-active" : "") + (isError ? " is-error" : "")}>
      <button type="button" className="thinking__header" onClick={onToggle}>
        {active ? <Spinner /> : <Chevron open={entry.expanded} />}
        <span className="thinking__summary">{summary}</span>
        {entry.agentName && !active && (
          <span className="thinking__agent">{entry.agentName}</span>
        )}
      </button>

      {entry.expanded && (
        <ul className="thinking__steps">
          {STEPS.map((step, i) => {
            const state = i < stepIndex ? "done" : i === stepIndex && active ? "active" : isError && i === stepIndex ? "error" : "pending";
            return (
              <li key={step.key} className={`thinking__step is-${state}`}>
                <span className="thinking__marker" />
                <span>
                  {step.key === "routed" && entry.agentName ? `Routed to ${entry.agentName}` : step.label}
                </span>
              </li>
            );
          })}
          {isError && <li className="thinking__step is-error"><span className="thinking__marker" />{entry.error}</li>}
        </ul>
      )}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — nothing we can do about it here.
    }
  }

  return (
    <button type="button" className="bubble-copy" onClick={handleCopy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function Spinner() {
  return <span className="spinner" />;
}

function Chevron({ open }) {
  return <span className={"chevron" + (open ? " is-open" : "")}>▸</span>;
}

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M5.5 2v3M10.5 2v3M4 5h8v3a4 4 0 0 1-4 4 4 4 0 0 1-4-4V5ZM8 12v2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1.2" fill="currentColor" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" fill="currentColor" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" fill="currentColor" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" fill="currentColor" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M11.1 2.4a1.2 1.2 0 0 1 1.7 0l0.8 0.8a1.2 1.2 0 0 1 0 1.7L5.4 13.1l-2.9 0.7 0.7-2.9L11.1 2.4Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M6 6h6.5A1 1 0 0 1 13.5 7v6.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM3.5 10.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v0.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 2v8m0 0L5 7m3 3l3-3M3 13.5h10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 4.5h9M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
