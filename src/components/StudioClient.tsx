"use client";

import type { ModelMessage } from "ai";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Loader = "fabric" | "forge" | "neoforge";
type VerOpt = { value: string; label: string };
type UiMsg = { id: string; role: "user" | "assistant"; content: string };

type SavedChat = {
  sessionId: string;
  title: string;
  loader: Loader;
  version: string;
  messages: UiMsg[];
  updatedAt: number;
};

const CHATS_KEY = "codexmc:chats";

function uid() {
  return crypto.randomUUID();
}

function loadChats(): SavedChat[] {
  try {
    return JSON.parse(localStorage.getItem(CHATS_KEY) ?? "[]") as SavedChat[];
  } catch {
    return [];
  }
}

function saveChats(chats: SavedChat[]) {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  } catch {}
}

function chatTitle(messages: UiMsg[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New chat";
  return first.content.slice(0, 40) + (first.content.length > 40 ? "…" : "");
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function StudioClient() {
  const [sessionId, setSessionId] = useState("");
  const [loader, setLoader] = useState<Loader>("fabric");
  const [version, setVersion] = useState("");
  const [versionOptions, setVersionOptions] = useState<VerOpt[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [draftAssistant, setDraftAssistant] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);
  const [buildBusy, setBuildBusy] = useState(false);
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const [jdkHint, setJdkHint] = useState<string | null>(null);
  const [jarReady, setJarReady] = useState(false);
  const [savedChats, setSavedChats] = useState<SavedChat[]>([]);
  const consoleRef = useRef<HTMLPreElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const buildLogRef = useRef<string[]>([]);

  // Load chat history from localStorage on mount
  useEffect(() => {
    setSavedChats(loadChats());
  }, []);

  // Persist current chat whenever messages change
  useEffect(() => {
    if (!sessionId || messages.length === 0) return;
    setSavedChats((prev) => {
      const updated: SavedChat = {
        sessionId,
        title: chatTitle(messages),
        loader,
        version,
        messages,
        updatedAt: Date.now(),
      };
      const rest = prev.filter((c) => c.sessionId !== sessionId);
      const next = [updated, ...rest];
      saveChats(next);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const appendLog = useCallback((line: string) => {
    setConsoleLines((c) => [...c.slice(-400), line]);
  }, []);

  useEffect(() => {
    consoleRef.current?.scrollTo({
      top: consoleRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [consoleLines]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, draftAssistant]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setVersionsLoading(true);
      try {
        const res = await fetch(`/api/versions?loader=${loader}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "versions");
        const opts = data.versions as VerOpt[];
        if (cancelled) return;
        setVersionOptions(opts);
        setVersion((v) => {
          if (v && opts.some((o) => o.value === v)) return v;
          return opts[0]?.value ?? "";
        });
      } catch (e) {
        if (!cancelled) {
          setVersionOptions([]);
          appendLog(
            `[codexmc] Version list failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } finally {
        if (!cancelled) setVersionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loader, appendLog]);

  const initWorkspace = useCallback(
    async (sid: string, ld: Loader, ver: string) => {
      if (!sid || !ver) return;
      setInitBusy(true);
      appendLog(`[codexmc] Initializing workspace (${ld}, ${ver})…`);
      try {
        const res = await fetch("/api/workspace/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid, loader: ld, version: ver }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        appendLog("[codexmc] Workspace ready (Gradle template copied).");
        setJarReady(false);
      } catch (e) {
        appendLog(
          `[codexmc] Init failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setInitBusy(false);
      }
    },
    [appendLog],
  );

  useEffect(() => {
    if (!sessionId) {
      const s = uid();
      setSessionId(s);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !version) return;
    const t = setTimeout(() => {
      void initWorkspace(sessionId, loader, version);
    }, 400);
    return () => clearTimeout(t);
  }, [sessionId, loader, version, initWorkspace]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/jdks/status");
        const j = await res.json();
        const eff = j.effective ?? j.JDK_21_HOME;
        setJdkHint(
          eff
            ? `Java: ${eff}`
            : "No JAVA_HOME detected — install JDK 21+ or run scripts/setup-jdks.sh on Linux.",
        );
      } catch {
        setJdkHint(null);
      }
    })();
  }, []);

  const newChat = () => {
    const s = uid();
    setSessionId(s);
    setMessages([]);
    setDraftAssistant(null);
    setInput("");
    setJarReady(false);
    appendLog("[codexmc] New chat session (workspace will re-initialize).");
  };

  const loadChat = (chat: SavedChat) => {
    setSessionId(chat.sessionId);
    setLoader(chat.loader);
    setVersion(chat.version);
    setMessages(chat.messages);
    setDraftAssistant(null);
    setInput("");
    setJarReady(false);
    appendLog(`[codexmc] Loaded chat: ${chat.title}`);
  };

  const deleteChat = (sid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSavedChats((prev) => {
      const next = prev.filter((c) => c.sessionId !== sid);
      saveChats(next);
      return next;
    });
    if (sid === sessionId) newChat();
  };

  const ingestBuildLine = useCallback((line: string) => {
    appendLog(line);
    buildLogRef.current.push(line);
    if (line.includes("[codexmc] BUILD_RESULT:ok")) setJarReady(true);
    if (line.includes("[codexmc] BUILD_RESULT:fail")) setJarReady(false);
  }, [appendLog]);

  // Shared AI streaming logic used by send() and auto-fix
  const sendToAi = useCallback(async (
    userText: string,
    currentMessages: UiMsg[],
  ): Promise<UiMsg[]> => {
    const userMsg: UiMsg = { id: uid(), role: "user", content: userText };
    const nextMessages = [...currentMessages, userMsg];
    setMessages(nextMessages);
    setBusy(true);
    setDraftAssistant("");
    appendLog("[codexmc] AI request started…");

    const core: ModelMessage[] = nextMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, loader, version, messages: core }),
      });

      if (!res.ok) {
        const errText = await res.text();
        let msg = errText;
        try { msg = JSON.parse(errText).error ?? errText; } catch { /* plain */ }
        appendLog(`[codexmc] Chat error: ${msg}`);
        const errMsg: UiMsg = { id: uid(), role: "assistant", content: `**Error:** ${msg}` };
        const final = [...nextMessages, errMsg];
        setMessages(final);
        setDraftAssistant(null);
        return final;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let full = "";
      if (!reader) { setDraftAssistant(null); return nextMessages; }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        setDraftAssistant(full);
      }
      setDraftAssistant(null);
      const assistantMsg: UiMsg = { id: uid(), role: "assistant", content: full };
      const final = [...nextMessages, assistantMsg];
      setMessages(final);
      appendLog("[codexmc] AI response finished (files applied if fenced blocks were present).");
      return final;
    } catch (e) {
      appendLog(`[codexmc] Chat failed: ${e instanceof Error ? e.message : String(e)}`);
      setDraftAssistant(null);
      return nextMessages;
    } finally {
      setBusy(false);
    }
  }, [sessionId, loader, version, appendLog]);

  const fixBuildErrors = useCallback(async (
    buildLines: string[],
    currentMessages: UiMsg[],
  ): Promise<UiMsg[]> => {
    // Focus on the most useful lines; cap at 80 to keep prompt reasonable
    const relevant = buildLines.filter((l) =>
      /error:|ERROR|FAILED|Exception|> Task|warning:/.test(l)
    );
    const block = (relevant.length > 0 ? relevant : buildLines).slice(-80).join("\n");
    appendLog("[codexmc] —— Asking AI to fix build errors ——");
    const prompt =
      `The Gradle build just failed. Here is the build output:\n\n\`\`\`\n${block}\n\`\`\`\n\n` +
      `Please analyse the errors, fix the affected source files, and output every corrected file ` +
      `using the codexmc fenced block format so they are applied to the workspace automatically.`;
    return sendToAi(prompt, currentMessages);
  }, [appendLog, sendToAi]);

  const runBuild = useCallback(async (autoFix = false, currentMessages = messages) => {
    if (!sessionId) return;
    setBuildBusy(true);
    setJarReady(false);
    buildLogRef.current = [];
    appendLog("[codexmc] —— Build started ——");
    let failed = false;
    try {
      const res = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const t = await res.text();
        appendLog(`[codexmc] Build HTTP ${res.status}: ${t}`);
        failed = true;
        return;
      }
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      if (!reader) return;
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) ingestBuildLine(line);
      }
      if (buf) ingestBuildLine(buf);
      failed = buildLogRef.current.some((l) => l.includes("[codexmc] BUILD_RESULT:fail"));
    } catch (e) {
      appendLog(`[codexmc] Build error: ${e instanceof Error ? e.message : String(e)}`);
      setJarReady(false);
      failed = true;
    } finally {
      appendLog("[codexmc] —— Build finished ——");
      setBuildBusy(false);
    }

    if (failed && autoFix) {
      const capturedLog = [...buildLogRef.current];
      const updatedMessages = await fixBuildErrors(capturedLog, currentMessages);
      appendLog("[codexmc] —— Auto-rebuilding after AI fix ——");
      await runBuild(false, updatedMessages);
    }
  }, [sessionId, appendLog, ingestBuildLine, fixBuildErrors, messages]);

  const downloadJar = async () => {
    if (!sessionId || !jarReady) return;
    appendLog("[codexmc] Preparing download…");
    try {
      const res = await fetch(
        `/api/artifact?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        appendLog(
          `[codexmc] Download failed: ${err.error ?? res.statusText}`,
        );
        return;
      }
      const cd = res.headers.get("Content-Disposition");
      const quoted = cd?.match(/filename="([^"]+)"/i);
      const filename = quoted?.[1] ?? "mod.jar";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      appendLog(`[codexmc] Download started (${filename}).`);
    } catch (e) {
      appendLog(
        `[codexmc] Download error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !sessionId || !version || busy) return;
    setInput("");
    await sendToAi(text, messages);
  };

  return (
    <div className="flex h-[100dvh] flex-col bg-[var(--background)] md:flex-row">
      {/* Sidebar */}
      <aside className="flex w-full flex-shrink-0 flex-col border-[var(--border)] bg-[var(--surface)] md:h-full md:w-64 md:border-r">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <Link href="/" className="font-semibold tracking-tight">
            Codex<span className="text-[var(--accent)]">MC</span>
          </Link>
        </div>
        <div className="p-3">
          <button
            type="button"
            onClick={newChat}
            disabled={initBusy}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 text-left text-sm font-medium transition hover:border-[var(--accent-dim)] disabled:opacity-50"
          >
            + New chat
          </button>
        </div>

        {/* Chat history */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {savedChats.length === 0 && (
            <p className="px-2 py-3 text-xs text-[var(--muted)]">No saved chats yet.</p>
          )}
          {savedChats.map((chat) => (
            <div
              key={chat.sessionId}
              onClick={() => loadChat(chat)}
              className={`group mb-1 flex cursor-pointer items-start justify-between gap-1 rounded-lg px-3 py-2 text-sm transition hover:bg-[var(--surface-hover)] ${
                chat.sessionId === sessionId
                  ? "border border-[var(--accent-dim)] bg-[var(--surface-hover)]"
                  : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium leading-tight text-[var(--foreground)]">
                  {chat.title}
                </p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  {chat.loader} · {timeAgo(chat.updatedAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => deleteChat(chat.sessionId, e)}
                className="mt-0.5 shrink-0 text-[var(--muted)] opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                title="Delete chat"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="border-t border-[var(--border)] p-3 text-xs leading-relaxed text-[var(--muted)]">
          {jdkHint && <p className="mb-2">{jdkHint}</p>}
          <p>
            CodexMC uses Mistral coding models. Set{" "}
            <code className="font-mono text-[var(--foreground)]">MISTRAL_API_KEY</code> and
            optional <code className="font-mono">MISTRAL_MODEL</code>.
          </p>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)]/90 px-4 py-3 backdrop-blur-sm">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-[var(--muted)]">Loader</span>
            <select
              value={loader}
              onChange={(e) => setLoader(e.target.value as Loader)}
              className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 font-medium"
            >
              <option value="fabric">Fabric</option>
              <option value="forge">Forge</option>
              <option value="neoforge">NeoForge</option>
            </select>
          </label>
          <label className="flex min-w-[12rem] flex-1 items-center gap-2 text-sm">
            <span className="text-[var(--muted)]">Version</span>
            <select
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={versionsLoading || !versionOptions.length}
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5"
            >
              {versionOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => sessionId && void initWorkspace(sessionId, loader, version)}
            disabled={initBusy || !sessionId || !version}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            Re-sync template
          </button>
          <button
            type="button"
            onClick={() => void runBuild(true)}
            disabled={buildBusy || busy || !sessionId}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-[#06261a] disabled:opacity-50"
          >
            {buildBusy ? "Building…" : busy ? "AI fixing…" : "Build JAR"}
          </button>
          <button
            type="button"
            onClick={() => void downloadJar()}
            disabled={!jarReady || !sessionId}
            title={jarReady ? "Download the mod JAR from this session" : "Run a successful build first"}
            className="rounded-lg border border-[var(--accent-dim)] bg-[var(--surface)] px-4 py-1.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-40"
          >
            Download JAR
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {messages.length === 0 && !draftAssistant && (
                <div className="mx-auto mt-12 max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-[var(--muted)]">
                  <p className="text-[var(--foreground)]">
                    Describe the mod you want (gameplay, blocks, items, APIs).
                  </p>
                  <p className="mt-2 text-sm">
                    CodexMC writes fenced <code className="font-mono">codexmc:path</code>{" "}
                    files into your workspace; then use <strong>Build JAR</strong>.
                  </p>
                </div>
              )}
              <ul className="mx-auto flex max-w-3xl flex-col gap-4">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      m.role === "user"
                        ? "ml-8 bg-[var(--accent)]/15 text-[var(--foreground)]"
                        : "mr-8 border border-[var(--border)] bg-[var(--surface)]"
                    }`}
                  >
                    <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                      {m.role === "user" ? "You" : "CodexMC"}
                    </span>
                    <pre className="whitespace-pre-wrap font-sans">{m.content}</pre>
                  </li>
                ))}
                {draftAssistant !== null && (
                  <li className="mr-8 rounded-2xl border border-dashed border-[var(--accent-dim)] bg-[var(--surface)] px-4 py-3 text-sm">
                    <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">
                      CodexMC · streaming
                    </span>
                    <pre className="whitespace-pre-wrap font-sans text-[var(--muted)]">
                      {draftAssistant || "…"}
                    </pre>
                  </li>
                )}
                <div ref={bottomRef} />
              </ul>
            </div>

            <div className="border-t border-[var(--border)] p-3">
              <div className="mx-auto flex max-w-3xl gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  placeholder="Message CodexMC…"
                  disabled={busy || !version}
                  className="min-h-[44px] flex-1 resize-none rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none ring-[var(--accent)] focus:ring-2 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={busy || !input.trim() || !version}
                  className="self-end rounded-xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-[#06261a] disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>
          </div>

          <div className="flex h-48 min-h-0 flex-col border-t border-[var(--border)] bg-[#080a0e] lg:h-auto lg:w-[42%] lg:border-l lg:border-t-0">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                Live console
              </span>
              <button
                type="button"
                onClick={() => setConsoleLines([])}
                className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                Clear
              </button>
            </div>
            <pre
              ref={consoleRef}
              className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-snug text-[#b8c0d4]"
            >
              {consoleLines.join("\n")}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
