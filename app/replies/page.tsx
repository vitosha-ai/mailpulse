"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Replies — the classified reply feed (OOO miner). Three views on one page:
//   1. WORK THESE   — real human engagement (positive / question / referral)
//   2. OOO GOLD     — alternate contacts + return-date re-touch calendar
//   3. ALL REPLIES  — the full classified list with status controls

type Row = {
  id: number;
  replied_at: string;
  campaign_name: string | null;
  lead_email: string;
  lead_name: string | null;
  company: string | null;
  category: string;
  return_date: string | null;
  alt_contact_name: string | null;
  alt_contact_email: string | null;
  summary: string | null;
  snippet: string | null;
  status: string;
};

const CAT_BADGE: Record<string, string> = {
  positive: "bg-emerald-100 text-emerald-700",
  question: "bg-sky-100 text-sky-700",
  referral: "bg-violet-100 text-violet-700",
  negative: "bg-rose-100 text-rose-700",
  unsubscribe: "bg-rose-200 text-rose-800",
  auto_reply: "bg-amber-100 text-amber-700",
  other: "bg-slate-200 text-slate-600",
};

function Badge({ cat }: { cat: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${CAT_BADGE[cat] ?? CAT_BADGE.other}`}>
      {cat === "auto_reply" ? "OOO/auto" : cat}
    </span>
  );
}

export default function RepliesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [catFilter, setCatFilter] = useState<string>("all");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/replies");
    const data = await res.json();
    setRows(data.rows ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const setStatus = useCallback(async (id: number, status: string) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
    await fetch("/api/replies", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
  }, []);

  const work = useMemo(
    () => rows.filter((r) => ["positive", "question", "referral"].includes(r.category) && r.status === "New"),
    [rows],
  );
  const gold = useMemo(
    () => rows.filter((r) => r.category === "auto_reply" && (r.alt_contact_email || r.alt_contact_name || r.return_date) && r.status === "New"),
    [rows],
  );
  const filtered = useMemo(
    () => (catFilter === "all" ? rows : rows.filter((r) => r.category === catFilter)),
    [rows, catFilter],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.category] = (c[r.category] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-[1500px] p-6">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              Replies
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              classified campaign replies · OOO intelligence
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/outbound" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900">
              ← Outbound
            </a>
            <button onClick={load} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900">
              Refresh
            </button>
          </div>
        </header>

        {loading ? (
          <p className="py-16 text-center text-slate-400">Loading…</p>
        ) : (
          <>
            {/* 1 — WORK THESE */}
            <section className="mb-6 rounded-xl border border-emerald-200 bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-emerald-700">
                🎯 Work these now — real engagement ({work.length})
              </h2>
              {work.length === 0 ? (
                <p className="text-sm text-slate-400">Nothing new — all worked.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {work.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100">
                        <td className="py-2 pr-3"><Badge cat={r.category} /></td>
                        <td className="py-2 pr-3 font-medium">{r.lead_name || r.lead_email}<div className="text-xs text-slate-400">{r.company} · {r.lead_email}</div></td>
                        <td className="py-2 pr-3 text-slate-600">{r.summary || r.snippet?.slice(0, 120)}</td>
                        <td className="py-2 pr-3 text-xs text-slate-400">{r.campaign_name}</td>
                        <td className="py-2">
                          <button onClick={() => setStatus(r.id, "Worked")} className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">Mark worked</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* 2 — OOO GOLD */}
            <section className="mb-6 rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-amber-700">
                ⛏️ OOO gold — alternate contacts &amp; re-touch dates ({gold.length})
              </h2>
              {gold.length === 0 ? (
                <p className="text-sm text-slate-400">No unworked OOO intel.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="py-1 pr-3">Away</th>
                      <th className="py-1 pr-3">Back on</th>
                      <th className="py-1 pr-3">Alternate contact</th>
                      <th className="py-1 pr-3">Campaign</th>
                      <th className="py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {gold
                      .slice()
                      .sort((a, b) => (a.return_date || "9999").localeCompare(b.return_date || "9999"))
                      .map((r) => (
                        <tr key={r.id} className="border-t border-slate-100">
                          <td className="py-2 pr-3 font-medium">{r.lead_name || r.lead_email}<div className="text-xs text-slate-400">{r.company}</div></td>
                          <td className="py-2 pr-3">{r.return_date || <span className="text-slate-300">—</span>}</td>
                          <td className="py-2 pr-3">
                            {r.alt_contact_email || r.alt_contact_name ? (
                              <span className="font-medium text-violet-700">{r.alt_contact_name} {r.alt_contact_email && <span className="font-mono text-xs">&lt;{r.alt_contact_email}&gt;</span>}</span>
                            ) : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="py-2 pr-3 text-xs text-slate-400">{r.campaign_name}</td>
                          <td className="py-2">
                            <button onClick={() => setStatus(r.id, "Worked")} className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100">Mark worked</button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* 3 — ALL REPLIES */}
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">All replies ({rows.length})</h2>
                <div className="flex flex-wrap gap-1">
                  {["all", ...Object.keys(counts)].map((c) => (
                    <button key={c} onClick={() => setCatFilter(c)}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${catFilter === c ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                      {c === "auto_reply" ? "OOO" : c}{c !== "all" && ` (${counts[c]})`}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="py-1 pr-3">When</th>
                      <th className="py-1 pr-3">Who</th>
                      <th className="py-1 pr-3">Category</th>
                      <th className="py-1 pr-3">Summary</th>
                      <th className="py-1 pr-3">Campaign</th>
                      <th className="py-1 pr-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100 align-top">
                        <td className="py-2 pr-3 whitespace-nowrap text-xs text-slate-400">{r.replied_at?.slice(0, 16).replace("T", " ")}</td>
                        <td className="py-2 pr-3 font-medium">{r.lead_name || r.lead_email}<div className="text-xs text-slate-400">{r.company}</div></td>
                        <td className="py-2 pr-3"><Badge cat={r.category} /></td>
                        <td className="py-2 pr-3 max-w-[420px] text-slate-600">{r.summary || r.snippet?.slice(0, 140)}</td>
                        <td className="py-2 pr-3 text-xs text-slate-400">{r.campaign_name}</td>
                        <td className="py-2 pr-3">
                          <select value={r.status} onChange={(e) => setStatus(r.id, e.target.value)}
                            className="rounded border border-slate-200 bg-white px-1 py-0.5 text-xs">
                            {["New", "Worked", "Ignored"].map((s) => <option key={s}>{s}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
