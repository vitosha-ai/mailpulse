"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Lead tracker — ONE table across BOTH agents (US + GCC): who owns each lead
// (SDR), when it was contacted, what came back, and when the row last changed.
// Inline-editable; every save stamps updated_at.

type Row = {
  id: number;
  queued_date: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  verified_email: string | null;
  company: string | null;
  trigger_type: string | null;
  confidence: string | null;
  status: string;
  rep_notes: string | null;
  market: string | null;
  sdr: string | null;
  contacted_at: string | null;
  response: string | null;
  updated_at: string | null;
};

const STATUSES = ["Pending", "Verified", "Edited", "Sent", "Rejected", "Skipped"] as const;
const RESPONSE_SUGGESTIONS = [
  "No reply yet",
  "Interested — call booked",
  "Interested — asked for info",
  "Not interested",
  "Out of office",
  "Referred to colleague",
  "Do not contact",
  "Bounced",
];

const MARKET_LABELS: Record<string, string> = { us: "US", gcc: "GCC", healthcare: "Healthcare" };
const MARKET_BADGE: Record<string, string> = {
  us: "bg-slate-100 text-slate-500 ring-1 ring-slate-200",
  gcc: "bg-teal-100 text-teal-700 ring-1 ring-teal-300",
};
const STATUS_META: Record<string, string> = {
  Pending: "bg-slate-100 text-slate-600",
  Verified: "bg-blue-100 text-blue-700",
  Edited: "bg-violet-100 text-violet-700",
  Sent: "bg-emerald-100 text-emerald-700",
  Rejected: "bg-red-100 text-red-700",
  Skipped: "bg-slate-100 text-slate-400",
};

const fmt = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export default function Tracker() {
  const [rows, setRows] = useState<Row[]>([]);
  const [edits, setEdits] = useState<Record<number, Partial<Row>>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [market, setMarket] = useState("");
  const [statusF, setStatusF] = useState("");
  const [sdrF, setSdrF] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/outbound?all=1");
    const data = await res.json();
    setRows(data.rows ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const merged = useCallback((r: Row): Row => ({ ...r, ...edits[r.id] }), [edits]);
  const setField = (id: number, key: keyof Row, value: string) =>
    setEdits((e) => ({ ...e, [id]: { ...e[id], [key]: value } }));

  const save = async (r: Row) => {
    const fields = edits[r.id];
    if (!fields) return;
    setSaving(r.id);
    try {
      const res = await fetch("/api/outbound", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, fields }),
      });
      const data = await res.json();
      if (data.row) {
        setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, ...data.row } : x)));
        setEdits((e) => {
          const n = { ...e };
          delete n[r.id];
          return n;
        });
      }
    } finally {
      setSaving(null);
    }
  };

  const sdrs = useMemo(
    () => Array.from(new Set(rows.map((r) => (r.sdr || "").trim()).filter(Boolean))).sort(),
    [rows],
  );
  const markets = useMemo(() => Array.from(new Set(rows.map((r) => r.market || "us"))).sort(), [rows]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = rows.filter((r0) => {
      const r = merged(r0);
      if (market && (r.market || "us") !== market) return false;
      if (statusF && r.status !== statusF) return false;
      if (sdrF === "(unassigned)") {
        if ((r.sdr || "").trim()) return false;
      } else if (sdrF && (r.sdr || "").trim() !== sdrF) return false;
      if (needle) {
        const hay = `${r.company} ${r.first_name} ${r.last_name} ${r.verified_email} ${r.sdr} ${r.response}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    // Most recently touched first; untouched leads sink, newest queue first among them.
    out.sort((a, b) => {
      const ua = a.updated_at || "";
      const ub = b.updated_at || "";
      if (ua !== ub) return ub.localeCompare(ua);
      return (b.queued_date || "").localeCompare(a.queued_date || "") || b.id - a.id;
    });
    return out;
  }, [rows, market, statusF, sdrF, q, merged]);

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-[1600px] p-6">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              Lead Tracker
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              one board across both agents · who owns it · when contacted · what came back
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/outbound"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
            >
              ← Outbound
            </a>
            <a
              href="/"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
            >
              Dashboard
            </a>
          </div>
        </header>

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {markets.length > 1 && (
            <div className="flex overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm">
              <button
                onClick={() => setMarket("")}
                className={`px-3 py-2 text-xs font-medium ${market === "" ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-50"}`}
              >
                All markets
              </button>
              {markets.map((m) => (
                <button
                  key={m}
                  onClick={() => setMarket(market === m ? "" : m)}
                  className={`border-l border-slate-200 px-3 py-2 text-xs font-medium ${market === m ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-50"}`}
                >
                  {MARKET_LABELS[m] ?? m.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          <select
            value={statusF}
            onChange={(e) => setStatusF(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-600 shadow-sm outline-none focus:border-brand"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select
            value={sdrF}
            onChange={(e) => setSdrF(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-600 shadow-sm outline-none focus:border-brand"
          >
            <option value="">All SDRs</option>
            <option value="(unassigned)">Unassigned</option>
            {sdrs.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, contact, SDR, response…"
            className="min-w-[260px] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 placeholder-slate-400 shadow-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand/30"
          />
          <span className="text-[11px] text-slate-400">
            {visible.length} of {rows.length} leads
          </span>
        </div>

        {/* Table */}
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[1150px] text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-left font-mono text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2.5">Mkt</th>
                <th className="px-3 py-2.5">Lead</th>
                <th className="px-3 py-2.5">Trigger</th>
                <th className="px-3 py-2.5">Queued</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">SDR</th>
                <th className="px-3 py-2.5">Contacted</th>
                <th className="px-3 py-2.5">Response</th>
                <th className="px-3 py-2.5">Last update</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-400">
                    No leads match. New leads arrive with each nightly run.
                  </td>
                </tr>
              )}
              {visible.map((r0) => {
                const r = merged(r0);
                const dirty = !!edits[r0.id];
                return (
                  <tr key={r.id} className={`border-b border-slate-50 align-middle ${dirty ? "bg-amber-50/40" : ""}`}>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${MARKET_BADGE[r.market || "us"] ?? MARKET_BADGE.us}`}
                      >
                        {MARKET_LABELS[r.market || "us"] ?? (r.market || "us").toUpperCase()}
                      </span>
                    </td>
                    <td className="max-w-[230px] px-3 py-2">
                      <div className="truncate font-semibold text-slate-800">
                        {r.first_name ? `${r.first_name} ${r.last_name ?? ""}` : "(no contact)"}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">{r.company}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-500">{r.trigger_type}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{r.queued_date}</td>
                    <td className="px-3 py-2">
                      <select
                        value={r.status}
                        onChange={(e) => setField(r0.id, "status", e.target.value)}
                        className={`rounded-full border-0 px-2 py-1 text-[10px] font-medium outline-none ${STATUS_META[r.status] ?? ""}`}
                      >
                        {STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={r.sdr ?? ""}
                        onChange={(e) => setField(r0.id, "sdr", e.target.value)}
                        placeholder="assign…"
                        list="sdr-names"
                        className="w-[110px] rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-brand"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="date"
                        value={(r.contacted_at ?? "").slice(0, 10)}
                        onChange={(e) => setField(r0.id, "contacted_at", e.target.value)}
                        className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-700 outline-none focus:border-brand"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={r.response ?? ""}
                        onChange={(e) => setField(r0.id, "response", e.target.value)}
                        placeholder="what came back…"
                        list="response-suggestions"
                        className="w-[190px] rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-brand"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-slate-400" title={r.updated_at ?? ""}>
                      {fmt(r.updated_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => save(r0)}
                        disabled={!dirty || saving === r0.id}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                          dirty
                            ? "bg-brand text-white hover:bg-brand-dark"
                            : "cursor-default bg-slate-100 text-slate-300"
                        }`}
                      >
                        {saving === r0.id ? "…" : "Save"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <datalist id="sdr-names">
          {sdrs.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <datalist id="response-suggestions">
          {RESPONSE_SUGGESTIONS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <p className="mt-3 text-[11px] text-slate-400">
          Edits save per row and stamp &quot;Last update&quot; automatically. Statuses saved here appear
          on the Outbound page (and vice versa) — same leads, two views.
        </p>
      </div>
    </div>
  );
}
