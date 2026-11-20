"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Board for the US State & Local (SLED) RFP agent. One row = one open bid from
// Vitosha's BidPrime saved searches that Claude judged a Strong or Maybe fit
// for one of the seven service lines. Dropped bids are hidden unless asked for,
// so the team can check the filter isn't throwing away real work.

type Opp = {
  id: string;
  title: string;
  agency: string;
  state: string;
  entity_type: string;
  refnum: string;
  posted_date: string;
  due_date: string;
  url: string;
  alert_name: string;
  service_line: string;
  tier: "Strong" | "Maybe" | "Drop";
  reason: string;
  status: string;
  notes: string;
  first_seen: string;
  sent_at: string | null;
  source: string;
};

type Config = {
  mailbox: string | null;
  ai: boolean;
  resend: boolean;
  emailTo: string;
  lastRun: string | null;
  lastReport: string | null;
  lastEmail: string | null;
  aiUsage: string | null;
  failedEmails: number;
};

const STATUSES = ["New", "Reviewing", "Go", "No Bid", "Submitted"];
const LINES = ["Data & AI", "ERP & Enterprise Systems", "App Dev & Modernization", "Custom Software & Support", "IT Managed Services", "IT Staffing"];
const STATUS_META: Record<string, string> = {
  New: "bg-slate-100 text-slate-600",
  Reviewing: "bg-blue-100 text-blue-700",
  Go: "bg-emerald-100 text-emerald-700",
  "No Bid": "bg-slate-100 text-slate-400",
  Submitted: "bg-violet-100 text-violet-700",
};
const TIER_META: Record<string, string> = {
  Strong: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300",
  Maybe: "bg-amber-100 text-amber-700 ring-1 ring-amber-300",
  Drop: "bg-slate-100 text-slate-500",
};

const daysLeft = (due: string) => {
  if (!due) return null;
  return Math.round((new Date(due).getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / 86_400_000);
};
// Dates are YYYY-MM-DD strings, so plain string comparison is date order.
// A row with no date is hidden only when a range is set.
const inRange = (d: string, from: string, to: string) =>
  (!from && !to) || (!!d && (!from || d >= from) && (!to || d <= to));
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 1 ? "just now" : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

export default function SledBoard({ onExit }: { onExit: () => void }) {
  const [rows, setRows] = useState<Opp[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [tiers, setTiers] = useState<string[]>(["Strong", "Maybe"]);
  const [line, setLine] = useState("");
  const [stateF, setStateF] = useState("");
  const [src, setSrc] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [hideNoBid, setHideNoBid] = useState(true);
  // Calendar filter: which date to filter on, and a From-To range (inclusive).
  const [dateField, setDateField] = useState<"due" | "added">("due");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});

  const showDrops = tiers.includes("Drop");
  const load = useCallback(async () => {
    const r = await fetch(`/api/sled${showDrops ? "?drops=1" : ""}`);
    const j = await r.json();
    setRows(j.rows || []);
    setConfig(j.config || null);
    setEmailTo(j.config?.emailTo || "");
    setLoading(false);
  }, [showDrops]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    load();
  }, [load]);

  const act = async (action: string, extra: Record<string, string> = {}) => {
    setBusy(action);
    setMsg("");
    try {
      const r = await fetch("/api/sled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await r.json();
      if (!r.ok) setMsg(`⚠ ${j.error || r.status}`);
      else if (action === "run")
        setMsg(j.report.note ? `⚠ ${j.report.note}` :
          `Read ${j.report.emails} alert email${j.report.emails === 1 ? "" : "s"} · ${j.report.bids} bids · ${j.report.inserted} new · ${j.report.dropped} dropped as not IT · ${j.report.tooLate} closing too soon${j.report.failed ? ` · ${j.report.failed} failed` : ""}`);
      else if (action === "email") setMsg(j.result.startsWith("sent") ? `✉ Email ${j.result}` : `⚠ ${j.result}`);
      else if (action === "settings") { setMsg("Saved."); setShowSettings(false); }
      await load();
    } finally {
      setBusy("");
    }
  };

  const patch = async (id: string, body: { status?: string; notes?: string }) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...body } : r)));
    await fetch("/api/sled", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
  };

  const today = new Date().toISOString().slice(0, 10);
  const states = useMemo(() => Array.from(new Set(rows.map((r) => r.state).filter(Boolean))).sort(), [rows]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (tiers.length === 0 || tiers.includes(r.tier)) &&
        (!line || r.service_line === line) &&
        (!stateF || r.state === stateF) &&
        (!src || (src === "direct" ? (r.source || "").startsWith("Direct") : !(r.source || "").startsWith("Direct"))) &&
        (!status || r.status === status) &&
        (!hideNoBid || r.status !== "No Bid" || status === "No Bid") &&
        inRange(dateField === "due" ? r.due_date : r.first_seen, from, to) &&
        (!needle || `${r.title} ${r.agency} ${r.refnum} ${r.alert_name}`.toLowerCase().includes(needle)),
    );
  }, [rows, tiers, line, stateF, src, status, q, hideNoBid, dateField, from, to]);

  const preset = (field: "due" | "added", days: number) => {
    setDateField(field);
    if (field === "due") { setFrom(today); setTo(dayOffset(days)); }
    else { setFrom(dayOffset(-days)); setTo(today); }
  };

  const kpi = useMemo(() => {
    const live = rows.filter((r) => r.tier !== "Drop" && r.status !== "No Bid");
    return [
      { label: "Open matches", value: live.length, tone: "text-slate-900" },
      { label: "Strong fit", value: live.filter((r) => r.tier === "Strong").length, tone: "text-emerald-600" },
      { label: "New today", value: rows.filter((r) => r.tier !== "Drop" && r.first_seen === today).length, tone: "text-brand" },
      { label: "Strong, due ≤ 7 days", value: live.filter((r) => r.tier === "Strong" && (daysLeft(r.due_date) ?? 99) <= 7).length, tone: "text-red-600" },
      { label: "Marked Go", value: rows.filter((r) => r.status === "Go").length, tone: "text-emerald-600" },
      { label: "Submitted", value: rows.filter((r) => r.status === "Submitted").length, tone: "text-violet-600" },
    ];
  }, [rows, today]);

  const usage = config?.aiUsage ? (JSON.parse(config.aiUsage) as { usd?: number }) : null;
  const setupMissing = config && (!config.mailbox || !config.ai);

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-7xl p-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <button onClick={onExit} className="mb-1 text-xs font-medium text-slate-400 hover:text-brand">← All agents</button>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">🏙️ US State &amp; Local RFPs</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              BidPrime saved searches + direct portal notices · all US states · filtered to Vitosha&apos;s 7 service lines · last read {ago(config?.lastRun ?? null)}
              {config?.lastEmail ? ` · last email ${ago(config.lastEmail)}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => act("run")} disabled={!!busy}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm hover:border-slate-400 disabled:opacity-50">
              {busy === "run" ? "Reading…" : "↻ Check mailbox"}
            </button>
            <a href="/api/sled/export"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm hover:border-slate-400">
              ⬇ Excel
            </a>
            <button onClick={() => act("email")} disabled={!!busy || !config?.emailTo}
              title={config?.emailTo ? `Send everything open to ${config.emailTo}` : "Set a recipient first"}
              className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark disabled:opacity-50">
              {busy === "email" ? "Sending…" : "✉ Email now"}
            </button>
            <button onClick={() => setShowSettings((s) => !s)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm hover:border-slate-400">⚙</button>
          </div>
        </header>

        {setupMissing && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Setup not finished:{!config?.mailbox && " read-only access to proposals@vitoshainc.com (where BidPrime alerts arrive) isn't connected."}
            {!config?.ai && " ANTHROPIC_API_KEY isn't set."} Bids will appear once both are in place.
          </div>
        )}
        {config && config.failedEmails > 0 && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {config.failedEmails} alert email{config.failedEmails === 1 ? "" : "s"} couldn&apos;t be read yet; they are retried every hour.
          </div>
        )}

        {showSettings && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <label className="text-xs font-semibold text-slate-600">Daily digest goes to (comma-separated)</label>
            <div className="mt-1 flex gap-2">
              <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="proposals@…"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
              <button onClick={() => act("settings", { emailTo })} disabled={!!busy}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">Save</button>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              One email each working day (Mon–Fri, not federal holidays) around 8 AM ET with the new matches.
              Mailbox {config?.mailbox ? `✓ ${config.mailbox}` : "✗ not connected"} · Claude {config?.ai ? "✓" : "✗ not configured"} · Resend {config?.resend ? "✓" : "✗ not configured"}
              {usage?.usd !== undefined ? ` · AI cost so far $${usage.usd.toFixed(2)}` : ""}
            </p>
          </div>
        )}
        {msg && <p className="mb-3 rounded-lg bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">{msg}</p>}

        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {kpi.map((k) => (
            <div key={k.label} className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
              <p className={`text-xl font-bold leading-tight ${k.tone}`}>{k.value}</p>
              <p className="font-mono text-[9px] font-semibold uppercase tracking-wider text-slate-500">{k.label}</p>
            </div>
          ))}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          {(["Strong", "Maybe", "Drop"] as const).map((t) => (
            <button key={t}
              onClick={() => setTiers((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))}
              title={t === "Drop" ? "Show bids the filter removed as not IT services" : undefined}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${tiers.includes(t) ? TIER_META[t] : "bg-white text-slate-400 ring-1 ring-slate-200"}`}>
              {t === "Drop" ? "Dropped" : t}{t !== "Drop" || showDrops ? ` · ${rows.filter((r) => r.tier === t).length}` : ""}
            </button>
          ))}
          <select value={line} onChange={(e) => setLine(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
            <option value="">All service lines</option>
            {LINES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={stateF} onChange={(e) => setStateF(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
            <option value="">All states</option>
            {states.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={src} onChange={(e) => setSrc(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
            <option value="">All sources</option>
            <option value="bidprime">BidPrime</option>
            <option value="direct">Direct from portals</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input type="checkbox" checked={hideNoBid} onChange={(e) => setHideNoBid(e.target.checked)} /> hide No Bid
          </label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, agency, ref #…"
            className="ml-auto w-64 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs" />
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
          <span className="font-semibold text-slate-600">📅 Dates</span>
          <select value={dateField} onChange={(e) => setDateField(e.target.value as "due" | "added")}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1">
            <option value="due">Due date</option>
            <option value="added">Date added</option>
          </select>
          <label className="flex items-center gap-1 text-slate-500">From
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-0.5" />
          </label>
          <label className="flex items-center gap-1 text-slate-500">To
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-0.5" />
          </label>
          <span className="mx-1 text-slate-300">|</span>
          {([["Due in 7 days", "due", 7], ["Due in 30 days", "due", 30], ["Added today", "added", 0], ["Added last 7 days", "added", 7]] as const).map(([label, f, d]) => (
            <button key={label} onClick={() => preset(f, d)}
              className="rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-600 hover:bg-slate-200">{label}</button>
          ))}
          {(from || to) && (
            <button onClick={() => { setFrom(""); setTo(""); }} className="ml-1 text-brand hover:underline">Clear dates</button>
          )}
          <span className="ml-auto text-slate-400">{shown.length} shown</span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">Fit</th>
                <th className="px-3 py-2">Opportunity</th>
                <th className="px-3 py-2">Service line</th>
                <th className="px-3 py-2">Agency type</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Loading…</td></tr>}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                  No opportunities yet. {setupMissing ? "Finish the setup above first." : "Click ↻ Check mailbox to read the latest BidPrime alerts."}
                </td></tr>
              )}
              {!loading && rows.length > 0 && shown.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Nothing matches these filters.</td></tr>
              )}
              {shown.map((r) => {
                const d = daysLeft(r.due_date);
                const isOpen = open === r.id;
                return (
                  <FragmentRow key={r.id}>
                    <tr onClick={() => setOpen(isOpen ? null : r.id)}
                      className={`cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50 ${isOpen ? "bg-slate-50" : ""} ${r.tier === "Drop" ? "opacity-60" : ""}`}>
                      <td className="px-3 py-2">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${TIER_META[r.tier]}`}>{r.tier === "Drop" ? "Dropped" : r.tier}</span>
                      </td>
                      <td className="max-w-xl px-3 py-2">
                        <p className="font-medium text-slate-900">
                          {r.first_seen === today && r.tier !== "Drop" && <span className="mr-1.5 rounded bg-brand px-1.5 py-0.5 text-[9px] font-bold text-white">NEW</span>}
                          {r.title}
                        </p>
                        <p className="text-xs text-slate-500">
                          {r.agency}{r.state ? ` · ${r.state}` : ""}
                          {(r.source || "").startsWith("Direct") && (
                            <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">{r.source}</span>
                          )}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">{r.service_line === "None" ? "—" : r.service_line}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600">{r.entity_type}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        <span className={d !== null && d <= 7 ? "font-semibold text-red-600" : "text-slate-600"}>{r.due_date || "—"}</span>
                        {d !== null && <p className="text-[10px] text-slate-400">{d}d left</p>}
                      </td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <select value={r.status} onChange={(e) => patch(r.id, { status: e.target.value })}
                          className={`rounded-full border-0 px-2 py-0.5 text-xs font-medium ${STATUS_META[r.status] || ""}`}>
                          {STATUSES.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="grid gap-4 text-xs md:grid-cols-3">
                            <div className="space-y-1">
                              <p className="font-mono text-[9px] font-semibold uppercase tracking-wider text-slate-500">Bid</p>
                              <p className="text-slate-700">Ref # {r.refnum || "—"}</p>
                              <p className="text-slate-500">Posted {r.posted_date || "—"} · first seen {r.first_seen}</p>
                              {r.alert_name && <p className="text-slate-500">BidPrime alert: {r.alert_name}</p>}
                              {r.url ? (
                                <a href={r.url} target="_blank" rel="noreferrer"
                                  className="mt-2 inline-block rounded-lg bg-brand px-3 py-1.5 font-semibold text-white hover:bg-brand-dark">{(r.source || "").startsWith("Direct") ? "Open on the portal ↗" : "Open in BidPrime ↗"}</a>
                              ) : <p className="pt-1 text-slate-400">{(r.source || "").startsWith("Direct") ? `Open the notice in proposals@ (from ${r.source.replace("Direct · ", "")}).` : "No link in the alert email; search BidPrime for the title."}</p>}
                            </div>
                            <div className="space-y-1">
                              <p className="font-mono text-[9px] font-semibold uppercase tracking-wider text-slate-500">Why this fit</p>
                              <p className="text-slate-700">{r.reason}</p>
                              {r.sent_at && <p className="pt-1 text-slate-400">In the digest of {r.sent_at.slice(0, 10)}</p>}
                            </div>
                            <div className="space-y-1">
                              <p className="font-mono text-[9px] font-semibold uppercase tracking-wider text-slate-500">Team notes</p>
                              <textarea
                                value={noteDraft[r.id] ?? r.notes}
                                onChange={(e) => setNoteDraft((n) => ({ ...n, [r.id]: e.target.value }))}
                                onBlur={() => {
                                  const v = noteDraft[r.id];
                                  if (v !== undefined && v !== r.notes) patch(r.id, { notes: v });
                                }}
                                rows={4} placeholder="Go/no-bid reasoning, teaming partner, who owns it…"
                                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs" />
                              <p className="text-[10px] text-slate-400">Saves when you click away.</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-center text-[11px] text-slate-400">
          Fit is judged by Claude from the bid title and agency against Vitosha&apos;s service lines. Construction, equipment, licence-only,
          federal and anything closing within 3 days are dropped. Turn on &quot;Dropped&quot; to check what was filtered out.
        </p>
      </div>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
