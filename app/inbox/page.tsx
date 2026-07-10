"use client";

import { useCallback, useEffect, useState } from "react";

type Message = {
  uid: number;
  from_email: string;
  from_name: string;
  to_email: string;
  subject: string;
  preview: string;
  body: string;
  received_at: string;
  category: string;
  seen: number;
};

const CATS: { key: string; label: string; cls: string }[] = [
  { key: "", label: "All", cls: "text-slate-700" },
  { key: "interested", label: "Interested", cls: "text-emerald-700" },
  { key: "out-of-office", label: "Out of office", cls: "text-amber-700" },
  { key: "unsubscribe", label: "Unsubscribe", cls: "text-red-700" },
  { key: "auto-reply", label: "Bounces", cls: "text-slate-500" },
  { key: "other", label: "Other", cls: "text-slate-700" },
];

const CAT_BADGE: Record<string, string> = {
  interested: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300",
  "out-of-office": "bg-amber-100 text-amber-700 ring-1 ring-amber-300",
  unsubscribe: "bg-red-100 text-red-700 ring-1 ring-red-400",
  "auto-reply": "bg-slate-100 text-slate-500 ring-1 ring-slate-300",
  other: "bg-brand/10 text-brand ring-1 ring-brand/30",
};

export default function Inbox() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [unseen, setUnseen] = useState(0);
  const [total, setTotal] = useState(0);
  const [warmupFiltered, setWarmupFiltered] = useState(0);
  const [cat, setCat] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Message | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (cat) qs.set("category", cat);
    if (search) qs.set("q", search);
    const res = await fetch(`/api/inbox?${qs}`);
    const d = await res.json();
    setMessages(d.messages ?? []);
    setCounts(d.counts ?? {});
    setUnseen(d.unseen ?? 0);
    setTotal(d.total ?? 0);
    setWarmupFiltered(d.warmupFiltered ?? 0);
  }, [cat, search]);

  useEffect(() => {
    load();
  }, [load]);

  const sync = async () => {
    setBusy("Reading master inbox and filtering warmup…");
    const res = await fetch("/api/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sync" }),
    });
    const d = await res.json();
    setBusy(null);
    if (d.result) alert(d.result);
    load();
  };

  const openMessage = async (m: Message) => {
    setOpen(m);
    if (!m.seen) {
      await fetch("/api/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seen", uid: m.uid }),
      });
      setMessages((ms) => ms.map((x) => (x.uid === m.uid ? { ...x, seen: 1 } : x)));
      setUnseen((u) => Math.max(0, u - 1));
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-[1400px] p-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-3xl font-bold tracking-tight text-transparent">
              Inbox
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              {total} real replies · {unseen} unread · {warmupFiltered} warmup filtered out
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={sync}
              disabled={!!busy}
              className="rounded-lg bg-gradient-to-r from-brand to-brand-light px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-dark hover:to-brand disabled:opacity-40"
            >
              ⟳ Refresh inbox
            </button>
            <a
              href="/"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
            >
              ← Dashboard
            </a>
          </div>
        </header>

        {busy && (
          <div className="mb-4 rounded-xl border border-brand/40 bg-brand/5 px-4 py-3 text-sm text-brand">
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
              {busy}
            </span>
          </div>
        )}

        {total === 0 && !busy && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
            No replies yet. Add your master-inbox IMAP details in{" "}
            <a href="/settings" className="text-brand underline">Settings</a>, then hit{" "}
            <b className="text-slate-700">⟳ Refresh inbox</b>. Warmup emails are filtered out automatically.
          </div>
        )}

        {/* Category tabs + search */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {CATS.map((c) => (
            <button
              key={c.key}
              onClick={() => setCat(c.key)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium shadow-sm transition ${
                cat === c.key ? "border-brand bg-brand/10 text-brand" : "border-slate-300 bg-white hover:border-slate-400"
              }`}
            >
              {c.label}
              {c.key && counts[c.key] ? <span className="ml-1.5 text-xs text-slate-400">{counts[c.key]}</span> : null}
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="⌕ search sender or subject…"
            className="ml-auto w-64 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 placeholder-slate-400 shadow-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand/40"
          />
        </div>

        {/* Message list */}
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <ul className="divide-y divide-slate-100">
            {messages.map((m) => (
              <li key={m.uid}>
                <button
                  onClick={() => openMessage(m)}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50 ${
                    m.seen ? "" : "bg-brand/5"
                  }`}
                >
                  {!m.seen && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand" />}
                  {m.seen && <span className="mt-2 h-2 w-2 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-sm ${m.seen ? "font-medium text-slate-700" : "font-bold text-slate-900"}`}>
                        {m.from_name || m.from_email}
                      </span>
                      <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${CAT_BADGE[m.category] ?? CAT_BADGE.other}`}>
                        {m.category}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-slate-700">{m.subject || "(no subject)"}</span>
                    <span className="mt-0.5 block truncate text-xs text-slate-400">{m.preview}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-slate-400">
                    {m.received_at?.replace("T", " ").slice(0, 16)}
                  </span>
                </button>
              </li>
            ))}
            {messages.length === 0 && total > 0 && (
              <li className="px-4 py-8 text-center text-sm text-slate-400">No messages match this filter.</li>
            )}
          </ul>
        </div>
      </div>

      {/* Message detail drawer */}
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={() => setOpen(null)}>
          <div
            className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${CAT_BADGE[open.category] ?? CAT_BADGE.other}`}>
                  {open.category}
                </span>
                <h2 className="mt-2 text-lg font-bold text-slate-900">{open.subject || "(no subject)"}</h2>
              </div>
              <button onClick={() => setOpen(null)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>
            <div className="mb-4 space-y-1 border-b border-slate-200 pb-4 text-sm">
              <p><span className="text-slate-400">From:</span> <b className="text-slate-800">{open.from_name}</b> &lt;{open.from_email}&gt;</p>
              <p><span className="text-slate-400">Replied to:</span> {open.to_email}</p>
              <p><span className="text-slate-400">When:</span> {open.received_at?.replace("T", " ").slice(0, 16)}</p>
            </div>
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700">{open.body || open.preview}</pre>
            <p className="mt-6 text-xs text-slate-400">
              Reply from your sequencer (Saleshandy/Smartlead) to keep the thread on the sending mailbox.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
