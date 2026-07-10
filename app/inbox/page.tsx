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
  flagged: number;
  pinned: number;
  tags: string[];
  esp: string | null;
};

// mm/dd/yyyy hh:mm AM/PM (12-hour) from an ISO/SQL timestamp.
function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd}/${yyyy} ${String(h).padStart(2, "0")}:${min} ${ampm}`;
}

const ESP_META: Record<string, { label: string; cls: string }> = {
  maildoso: { label: "Maildoso", cls: "bg-violet-100 text-violet-700 ring-violet-300" },
  microsoft: { label: "Microsoft", cls: "bg-brand/10 text-brand ring-brand/30" },
  google: { label: "Google", cls: "bg-red-100 text-red-700 ring-red-300" },
  other: { label: "Other", cls: "bg-slate-100 text-slate-500 ring-slate-300" },
};

type Group = { key: string; label: string; uids: number[] };
type Tag = { name: string; color: string; count: number };

const TAG_COLORS = ["slate", "blue", "emerald", "amber", "red", "violet", "pink", "cyan"];
const TAG_CLS: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700 ring-slate-300",
  blue: "bg-brand/10 text-brand ring-brand/30",
  emerald: "bg-emerald-100 text-emerald-700 ring-emerald-300",
  amber: "bg-amber-100 text-amber-700 ring-amber-300",
  red: "bg-red-100 text-red-700 ring-red-400",
  violet: "bg-violet-100 text-violet-700 ring-violet-300",
  pink: "bg-pink-100 text-pink-700 ring-pink-300",
  cyan: "bg-cyan-100 text-cyan-700 ring-cyan-300",
};

const CATS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "interested", label: "Interested" },
  { key: "out-of-office", label: "Out of office" },
  { key: "unsubscribe", label: "Unsubscribe" },
  { key: "auto-reply", label: "Bounces" },
  { key: "other", label: "Other" },
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
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [meta, setMeta] = useState({ unseen: 0, total: 0, warmupFiltered: 0, flaggedCount: 0, pinnedCount: 0 });
  const [cat, setCat] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");
  const [group, setGroup] = useState("");
  const [quick, setQuick] = useState(""); // "", unseen, flagged, pinned
  const [tagFilter, setTagFilter] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [open, setOpen] = useState<Message | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (cat) qs.set("category", cat);
    if (search) qs.set("q", search);
    if (sort) qs.set("sort", sort);
    if (group) qs.set("group", group);
    if (quick) qs.set(quick, "1");
    if (tagFilter) qs.set("tag", tagFilter);
    const res = await fetch(`/api/inbox?${qs}`);
    const d = await res.json();
    setMessages(d.messages ?? []);
    setGroups(d.groups ?? null);
    setCounts(d.counts ?? {});
    setTags(d.tags ?? []);
    setMeta({
      unseen: d.unseen ?? 0,
      total: d.total ?? 0,
      warmupFiltered: d.warmupFiltered ?? 0,
      flaggedCount: d.flaggedCount ?? 0,
      pinnedCount: d.pinnedCount ?? 0,
    });
  }, [cat, search, sort, group, quick, tagFilter]);

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

  const act = async (uid: number, action: string, value?: boolean) => {
    await fetch("/api/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, uid, value }),
    });
    load();
  };

  const openMessage = async (m: Message) => {
    setOpen(m);
    if (!m.seen) {
      await act(m.uid, "seen", true);
      setMessages((ms) => ms.map((x) => (x.uid === m.uid ? { ...x, seen: 1 } : x)));
    }
  };

  const toggleTag = async (uid: number, tag: string, add: boolean) => {
    await fetch("/api/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tag", uid, tag, value: add }),
    });
    // optimistic local update
    const upd = (m: Message) =>
      m.uid === uid ? { ...m, tags: add ? [...new Set([...m.tags, tag])] : m.tags.filter((t) => t !== tag) } : m;
    setMessages((ms) => ms.map(upd));
    if (open?.uid === uid) setOpen((o) => (o ? upd(o) : o));
    load();
  };

  const createAndApplyTag = async (uid: number) => {
    const name = prompt("New tag name (e.g. Hot lead, Demo booked, Follow up):");
    if (name && name.trim()) await toggleTag(uid, name.trim(), true);
  };

  const tagCls = (name: string) => {
    const color = tags.find((t) => t.name === name)?.color ?? "slate";
    return TAG_CLS[color] ?? TAG_CLS.slate;
  };

  const byUid = new Map(messages.map((m) => [m.uid, m]));
  const renderList = (list: Message[]) => (
    <ul className="divide-y divide-slate-100">
      {list.map((m) => (
        <li key={m.uid} className={`group flex items-start gap-2 px-3 ${m.seen ? "" : "bg-brand/5"}`}>
          {/* pin */}
          <button
            onClick={() => act(m.uid, "pin", !m.pinned)}
            title={m.pinned ? "Unpin" : "Pin to top"}
            className={`mt-3 shrink-0 text-sm ${m.pinned ? "text-brand" : "text-slate-300 hover:text-slate-500"}`}
          >
            {m.pinned ? "📌" : "📍"}
          </button>
          {/* flag */}
          <button
            onClick={() => act(m.uid, "flag", !m.flagged)}
            title={m.flagged ? "Unflag" : "Flag as important"}
            className={`mt-3 shrink-0 text-sm ${m.flagged ? "text-amber-500" : "text-slate-300 hover:text-slate-500"}`}
          >
            {m.flagged ? "★" : "☆"}
          </button>
          <button onClick={() => openMessage(m)} className="flex min-w-0 flex-1 items-start gap-3 py-3 text-left">
            {!m.seen ? <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand" /> : <span className="mt-2 h-2 w-2 shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className={`truncate text-sm ${m.seen ? "font-medium text-slate-700" : "font-bold text-slate-900"}`}>
                  {m.from_name || m.from_email}
                </span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${CAT_BADGE[m.category] ?? CAT_BADGE.other}`}>
                  {m.category}
                </span>
                {(() => {
                  const e = ESP_META[m.esp ?? "other"] ?? ESP_META.other;
                  return (
                    <span
                      title={`Reply came to a ${e.label} mailbox: ${m.to_email}`}
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${e.cls}`}
                    >
                      {e.label}
                    </span>
                  );
                })()}
              </span>
              <span className="mt-0.5 block truncate text-sm text-slate-700">{m.subject || "(no subject)"}</span>
              <span className="mt-0.5 block truncate text-xs text-slate-400">{m.preview}</span>
              {m.tags.length > 0 && (
                <span className="mt-1 flex flex-wrap gap-1">
                  {m.tags.map((t) => (
                    <span key={t} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${tagCls(t)}`}>
                      {t}
                    </span>
                  ))}
                </span>
              )}
            </span>
            <span className="shrink-0 whitespace-nowrap font-mono text-xs text-slate-400">
              {fmtDate(m.received_at)}
            </span>
          </button>
          {/* tag + not-a-reply */}
          <span className="mt-2.5 flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
            <span className="group/tag relative">
              <button title="Add tag" className="text-xs text-slate-400 hover:text-brand">🏷</button>
              <span className="absolute right-0 top-5 z-10 hidden min-w-[9rem] flex-col rounded-lg border border-slate-200 bg-white p-1 shadow-lg group-hover/tag:flex">
                {tags.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => toggleTag(m.uid, t.name, !m.tags.includes(t.name))}
                    className="flex items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-slate-50"
                  >
                    <span className={`rounded px-1.5 py-0.5 ring-1 ${tagCls(t.name)}`}>{t.name}</span>
                    {m.tags.includes(t.name) && <span className="text-emerald-600">✓</span>}
                  </button>
                ))}
                <button onClick={() => createAndApplyTag(m.uid)} className="rounded px-2 py-1 text-left text-xs text-brand hover:bg-slate-50">
                  + New tag…
                </button>
              </span>
            </span>
            <button
              onClick={() => act(m.uid, "mark-warmup")}
              title="Not a real reply — hide as warmup"
              className="text-xs text-slate-300 hover:text-red-500"
            >
              ✕
            </button>
          </span>
        </li>
      ))}
      {list.length === 0 && <li className="px-4 py-8 text-center text-sm text-slate-400">No messages match this filter.</li>}
    </ul>
  );

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-[1400px] p-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
              <span>📬</span>
              <span className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-transparent">
                Inbox
              </span>
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              {meta.total} real replies · {meta.unseen} unread · {meta.warmupFiltered} warmup filtered out
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
            <a href="/" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900">
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

        {meta.total === 0 && !busy && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
            No replies yet. Add your <b className="text-slate-700">Maildoso API key</b> in{" "}
            <a href="/settings" className="text-brand underline">Settings</a>, then hit{" "}
            <b className="text-slate-700">⟳ Refresh inbox</b>. Warmup emails are filtered out automatically.
          </div>
        )}

        {/* Category tabs */}
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
        </div>

        {/* Tag filter bar */}
        {tags.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Tags:</span>
            {tags.map((t) => (
              <button
                key={t.name}
                onClick={() => setTagFilter(tagFilter === t.name ? "" : t.name)}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 transition ${tagCls(t.name)} ${
                  tagFilter === t.name ? "ring-2" : "opacity-80 hover:opacity-100"
                }`}
              >
                {t.name} <span className="opacity-60">{t.count}</span>
              </button>
            ))}
            {tagFilter && (
              <button onClick={() => setTagFilter("")} className="text-xs text-slate-400 underline hover:text-slate-700">
                clear
              </button>
            )}
          </div>
        )}

        {/* Toolbar: quick filters + sort + group + search */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {[
            { k: "", label: "Everything" },
            { k: "unseen", label: `Unread (${meta.unseen})` },
            { k: "flagged", label: `★ Flagged (${meta.flaggedCount})` },
            { k: "pinned", label: `📌 Pinned (${meta.pinnedCount})` },
          ].map((f) => (
            <button
              key={f.k}
              onClick={() => setQuick(f.k)}
              className={`rounded-lg border px-3 py-1.5 text-sm shadow-sm transition ${
                quick === f.k ? "border-brand bg-brand/10 text-brand" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
              }`}
            >
              {f.label}
            </button>
          ))}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-600 shadow-sm outline-none focus:border-brand"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="sender">By sender</option>
            <option value="category">By category</option>
            <option value="unread">Unread first</option>
          </select>
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-600 shadow-sm outline-none focus:border-brand"
          >
            <option value="">No grouping</option>
            <option value="category">Group by category</option>
            <option value="sender">Group by sender domain</option>
            <option value="date">Group by date</option>
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="⌕ search sender, subject, body…"
            className="ml-auto w-72 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 placeholder-slate-400 shadow-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand/40"
          />
        </div>

        {/* Message list (grouped or flat) */}
        {groups ? (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.key} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">
                  <span>{g.label}</span>
                  <span className="font-mono text-xs text-slate-400">{g.uids.length}</span>
                </div>
                {renderList(g.uids.map((u) => byUid.get(u)!).filter(Boolean))}
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">{renderList(messages)}</div>
        )}
      </div>

      {/* Detail drawer */}
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={() => setOpen(null)}>
          <div className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${CAT_BADGE[open.category] ?? CAT_BADGE.other}`}>
                  {open.category}
                </span>
                <h2 className="mt-2 text-lg font-bold text-slate-900">{open.subject || "(no subject)"}</h2>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => act(open.uid, "flag", !open.flagged)} title="Flag" className={open.flagged ? "text-amber-500" : "text-slate-300 hover:text-slate-500"}>★</button>
                <button onClick={() => act(open.uid, "pin", !open.pinned)} title="Pin" className={open.pinned ? "text-brand" : "text-slate-300 hover:text-slate-500"}>📌</button>
                <button onClick={() => setOpen(null)} className="text-slate-400 hover:text-slate-700">✕</button>
              </div>
            </div>
            <div className="mb-4 space-y-1 border-b border-slate-200 pb-4 text-sm">
              <p><span className="text-slate-400">From:</span> <b className="text-slate-800">{open.from_name}</b> &lt;{open.from_email}&gt;</p>
              <p>
                <span className="text-slate-400">Replied to:</span> {open.to_email}{" "}
                {(() => {
                  const e = ESP_META[open.esp ?? "other"] ?? ESP_META.other;
                  return <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ${e.cls}`}>{e.label}</span>;
                })()}
              </p>
              <p><span className="text-slate-400">When:</span> {fmtDate(open.received_at)}</p>
              <div className="flex flex-wrap items-center gap-1.5 pt-2">
                <span className="text-slate-400">Tags:</span>
                {open.tags.map((t) => (
                  <button
                    key={t}
                    onClick={() => toggleTag(open.uid, t, false)}
                    title="Remove tag"
                    className={`rounded px-1.5 py-0.5 text-xs font-semibold ring-1 ${tagCls(t)}`}
                  >
                    {t} ✕
                  </button>
                ))}
                {tags
                  .filter((t) => !open.tags.includes(t.name))
                  .map((t) => (
                    <button
                      key={t.name}
                      onClick={() => toggleTag(open.uid, t.name, true)}
                      className="rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-xs text-slate-500 hover:border-brand hover:text-brand"
                    >
                      + {t.name}
                    </button>
                  ))}
                <button onClick={() => createAndApplyTag(open.uid)} className="rounded px-1.5 py-0.5 text-xs font-semibold text-brand hover:underline">
                  + New tag
                </button>
              </div>
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
