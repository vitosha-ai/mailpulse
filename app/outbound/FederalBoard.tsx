"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Board for the US Federal RFP agent (SAM.gov). One row = one open federal
// opportunity Vitosha can bid on, ranked by fit. Expand a row for the
// contracting officer, why it scored that way, and team notes.

type Opp = {
  notice_id: string;
  title: string;
  notice_type: string;
  solicitation_no: string;
  agency: string;
  sub_agency: string;
  set_aside: string;
  naics: string;
  psc: string;
  psc_title: string;
  posted_date: string;
  due_date: string;
  state: string;
  place: string;
  co_name: string;
  co_email: string;
  co_phone: string;
  attachments: number;
  url: string;
  score: number;
  tier: "Strong" | "Maybe" | "Low";
  why: string;
  clearance: string;
  tags: string;
  status: string;
  notes: string;
  first_seen: string;
};

type Config = {
  apify: boolean;
  resend: boolean;
  emailTo: string;
  lastRun: string | null;
  lastReport: string | null;
  lastEmail: string | null;
};

const STATUSES = ["New", "Reviewing", "Go", "No Bid", "Submitted"];
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
  Low: "bg-slate-100 text-slate-500",
};
const shortType = (t: string) =>
  ({ "Combined Synopsis/Solicitation": "Combined", "Sources Sought": "Sources Sought", Solicitation: "Solicitation", Presolicitation: "Presol" } as Record<string, string>)[t] || t;

const daysLeft = (due: string) => {
  if (!due) return null;
  return Math.round((new Date(due).getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / 86_400_000);
};
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 1 ? "just now" : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

export default function FederalBoard({ onExit }: { onExit: () => void }) {
  const [rows, setRows] = useState<Opp[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [tiers, setTiers] = useState<string[]>(["Strong", "Maybe"]);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [hideNoBid, setHideNoBid] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch("/api/federal");
    const j = await r.json();
    setRows(j.rows || []);
    setConfig(j.config || null);
    setEmailTo(j.config?.emailTo || "");
    setLoading(false);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    load();
  }, [load]);

  const act = async (action: string, extra: Record<string, string> = {}) => {
    setBusy(action);
    setMsg("");
    try {
      const r = await fetch("/api/federal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await r.json();
      if (!r.ok) setMsg(`⚠ ${j.error || r.status}`);
      else if (action === "run") setMsg(`Pulled ${j.report.pulled} · ${j.report.inserted} new · ${j.report.updated} updated · ${j.report.ineligible} certified set-asides skipped · ${j.report.tooLate} due too soon`);
      else if (action === "email") setMsg(j.result.startsWith("sent") ? `✉ Email ${j.result}` : `⚠ ${j.result}`);
      else if (action === "settings") { setMsg("Saved."); setShowSettings(false); }
      await load();
    } finally {
      setBusy("");
    }
  };

  const patch = async (id: string, body: { status?: string; notes?: string }) => {
    setRows((rs) => rs.map((r) => (r.notice_id === id ? { ...r, ...body } : r)));
    await fetch("/api/federal", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
  };

  const today = new Date().toISOString().slice(0, 10);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (tiers.length === 0 || tiers.includes(r.tier)) &&
        (!status || r.status === status) &&
        (!hideNoBid || r.status !== "No Bid" || status === "No Bid") &&
        (!needle || `${r.title} ${r.agency} ${r.sub_agency} ${r.solicitation_no} ${r.co_name}`.toLowerCase().includes(needle)),
    );
  }, [rows, tiers, status, q, hideNoBid]);

  const kpi = useMemo(() => {
    const live = rows.filter((r) => r.status !== "No Bid");
    return [
      { label: "Open & eligible", value: live.length, tone: "text-slate-900" },
      { label: "Strong fit", value: live.filter((r) => r.tier === "Strong").length, tone: "text-emerald-600" },
      { label: "New today", value: rows.filter((r) => r.first_seen === today).length, tone: "text-brand" },
      { label: "Strong, due ≤ 7 days", value: live.filter((r) => r.tier === "Strong" && (daysLeft(r.due_date) ?? 99) <= 7).length, tone: "text-red-600" },
      { label: "Marked Go", value: rows.filter((r) => r.status === "Go").length, tone: "text-emerald-600" },
      { label: "Submitted", value: rows.filter((r) => r.status === "Submitted").length, tone: "text-violet-600" },
    ];
  }, [rows, today]);

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-7xl p-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <button onClick={onExit} className="mb-1 text-xs font-medium text-slate-400 hover:text-brand">← All agents</button>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">🏛️ US Federal RFPs</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              SAM.gov · IT services, temp staffing, HR consulting · small-business eligible · last pull {ago(config?.lastRun ?? null)}
              {config?.lastEmail ? ` · last email ${ago(config.lastEmail)}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => act("run")} disabled={!!busy}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm hover:border-slate-400 disabled:opacity-50">
              {busy === "run" ? "Pulling…" : "↻ Pull now"}
            </button>
            <a href="/api/federal/export"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm hover:border-slate-400">
              ⬇ Excel
            </a>
            <button onClick={() => act("email")} disabled={!!busy || !config?.emailTo}
              title={config?.emailTo ? `Send the ranked Excel to ${config.emailTo}` : "Set a recipient first"}
              className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark disabled:opacity-50">
              {busy === "email" ? "Sending…" : "✉ Email now"}
            </button>
            <button onClick={() => setShowSettings((s) => !s)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm hover:border-slate-400">⚙</button>
          </div>
        </header>

        {showSettings && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <label className="text-xs font-semibold text-slate-600">Daily email goes to (comma-separated)</label>
            <div className="mt-1 flex gap-2">
              <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="proposals@…"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
              <button onClick={() => act("settings", { emailTo })} disabled={!!busy}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">Save</button>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              Sent each morning only when new opportunities came in. Apify {config?.apify ? "✓" : "✗ not configured"} · Resend {config?.resend ? "✓" : "✗ not configured"}
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
          {(["Strong", "Maybe", "Low"] as const).map((t) => (
            <button key={t}
              onClick={() => setTiers((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${tiers.includes(t) ? TIER_META[t] : "bg-white text-slate-400 ring-1 ring-slate-200"}`}>
              {t} · {rows.filter((r) => r.tier === t).length}
            </button>
          ))}
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input type="checkbox" checked={hideNoBid} onChange={(e) => setHideNoBid(e.target.checked)} /> hide No Bid
          </label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, agency, officer…"
            className="ml-auto w-64 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs" />
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">Fit</th>
                <th className="px-3 py-2">Opportunity</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Set-aside</th>
                <th className="px-3 py-2">Clearance</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Loading…</td></tr>}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                  No opportunities yet. {config?.apify ? "Click ↻ Pull now to load the last 30 days." : "Add APIFY_TOKEN to the service first."}
                </td></tr>
              )}
              {!loading && rows.length > 0 && shown.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Nothing matches these filters.</td></tr>
              )}
              {shown.map((r) => {
                const d = daysLeft(r.due_date);
                const isOpen = open === r.notice_id;
                return (
                  <FragmentRow key={r.notice_id}>
                    <tr onClick={() => setOpen(isOpen ? null : r.notice_id)}
                      className={`cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50 ${isOpen ? "bg-slate-50" : ""}`}>
                      <td className="px-3 py-2">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${TIER_META[r.tier]}`}>{r.score}</span>
                      </td>
                      <td className="max-w-xl px-3 py-2">
                        <p className="font-medium text-slate-900">
                          {r.first_seen === today && <span className="mr-1.5 rounded bg-brand px-1.5 py-0.5 text-[9px] font-bold text-white">NEW</span>}
                          {r.title}
                        </p>
                        <p className="text-xs text-slate-500">{r.sub_agency || r.agency}{r.state ? ` · ${r.state}` : ""}</p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600">{shortType(r.notice_type)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        <span className={d !== null && d <= 7 ? "font-semibold text-red-600" : "text-slate-600"}>{r.due_date || "—"}</span>
                        {d !== null && <p className="text-[10px] text-slate-400">{d}d left</p>}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">{r.set_aside.replace(" Set-Aside", "")}</td>
                      <td className="px-3 py-2 text-xs">
                        <span className={r.clearance.startsWith("Needs") ? "font-semibold text-red-600" : r.clearance ? "text-amber-700" : "text-slate-300"}>
                          {r.clearance || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <select value={r.status} onChange={(e) => patch(r.notice_id, { status: e.target.value })}
                          className={`rounded-full border-0 px-2 py-0.5 text-xs font-medium ${STATUS_META[r.status] || ""}`}>
                          {STATUSES.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="grid gap-4 text-xs md:grid-cols-3">
                            <div className="space-y-1">
                              <p className="font-mono text-[9px] font-semibold uppercase tracking-wider text-slate-500">Contracting officer</p>
                              <p className="font-medium text-slate-800">{r.co_name || "—"}</p>
                              {r.co_email && <p><a className="text-brand hover:underline" href={`mailto:${r.co_email}`}>{r.co_email}</a></p>}
                              {r.co_phone && <p className="text-slate-600">{r.co_phone}</p>}
                              <p className="pt-2 text-slate-500">Solicitation # {r.solicitation_no || "—"} · NAICS {r.naics} · {r.psc} {r.psc_title && `(${r.psc_title})`}</p>
                              <p className="text-slate-500">Posted {r.posted_date} · {r.attachments} attachment{r.attachments === 1 ? "" : "s"}</p>
                              <a href={r.url} target="_blank" rel="noreferrer"
                                className="mt-2 inline-block rounded-lg bg-brand px-3 py-1.5 font-semibold text-white hover:bg-brand-dark">Open on SAM.gov ↗</a>
                            </div>
                            <div className="space-y-1">
                              <p className="font-mono text-[9px] font-semibold uppercase tracking-wider text-slate-500">Why this score</p>
                              <ul className="list-disc space-y-0.5 pl-4 text-slate-700">
                                {r.why.split("; ").map((w) => <li key={w}>{w}</li>)}
                              </ul>
                              {r.tags && <p className="pt-1 text-slate-500">Tags: {r.tags}</p>}
                              {r.place && <p className="text-slate-500">Place: {r.place}</p>}
                            </div>
                            <div className="space-y-1">
                              <p className="font-mono text-[9px] font-semibold uppercase tracking-wider text-slate-500">Team notes</p>
                              <textarea
                                value={noteDraft[r.notice_id] ?? r.notes}
                                onChange={(e) => setNoteDraft((n) => ({ ...n, [r.notice_id]: e.target.value }))}
                                onBlur={() => {
                                  const v = noteDraft[r.notice_id];
                                  if (v !== undefined && v !== r.notes) patch(r.notice_id, { notes: v });
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
          Ranked by fit with Vitosha&apos;s IT-services work. Certified set-asides (8(a), WOSB, HUBZone, SDVOSB, Native-owned) and anything due within 3 days are left out.
          Clearance needs are often only in the attachments — check before marking Go.
        </p>
      </div>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
