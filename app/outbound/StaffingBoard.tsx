"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Role-driven board for the Staffing agent (market=staffing). Unlike the
// email-sequence workspace, an SDR scans OPEN ROLES: what the role is, how
// long it's been bleeding, whether they take contractors, what the budget is,
// and who to call. One row = one role at one unique client; expand for the
// call opener, email draft, and notes.

type Row = {
  id: number;
  queued_date: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  verified_email: string | null;
  linkedin: string | null;
  company: string | null;
  trigger_detail: string | null; // "ROLE — open N day(s) · accepts contract · budget X · why"
  source_url: string | null;
  bucket: string | null;         // industry
  detected_stack: string | null; // vein label ("Dynamics 365", "PeopleSoft", ...)
  subject: string | null;        // call opener
  email_1: string | null;        // email draft
  status: string;
  rep_notes: string | null;
  phone: string | null;      // company switchboard from Apollo org enrich
  sdr: string | null;        // owner: an invited SDR's name, or "Ajay"
  size: string | null;
  fit_reason: string | null;     // reasons; "⚠ ALSO IN B2B EMAIL PIPELINE..." prefix = collision
  research_trail: string | null; // "score N · vein k · posting url"
};

const STATUSES = ["Pending", "Called", "Emailed", "Meeting", "No Fit", "Bad Contact"] as const;

const STATUS_META: Record<string, string> = {
  Pending: "bg-slate-100 text-slate-600",
  Called: "bg-blue-100 text-blue-700",
  Emailed: "bg-violet-100 text-violet-700",
  Meeting: "bg-emerald-100 text-emerald-700",
  "No Fit": "bg-slate-100 text-slate-400",
  "Bad Contact": "bg-red-100 text-red-700",
};

const role = (r: Row) => (r.trigger_detail || "").split(" — ")[0] || r.detected_stack || "";
const daysOpen = (r: Row) => {
  const m = /open (\d+) day/.exec(r.trigger_detail || "");
  return m ? Number(m[1]) : null;
};
const contractOk = (r: Row) => (r.trigger_detail || "").includes("accepts contract");
const budget = (r: Row) => {
  const m = /budget ([^·]+)/.exec(r.trigger_detail || "");
  return m ? m[1].trim() : "";
};
const score = (r: Row) => {
  const m = /score (\d+)/.exec(r.research_trail || "");
  return m ? Number(m[1]) : 0;
};
const collision = (r: Row) => (r.fit_reason || "").startsWith("⚠");
const reasons = (r: Row) => (r.fit_reason || "").replace(/^⚠[^·]*·\s*/, "");

const scoreTone = (s: number) =>
  s >= 85 ? "bg-red-100 text-red-700" : s >= 65 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600";

// Default column widths (px): Score, Role, Tech, Company, Days, Contract, Budget, Contact, Owner, Status.
const COL_DEFAULTS = [70, 240, 120, 200, 90, 80, 130, 190, 110, 110];

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <span onMouseDown={onMouseDown} onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-violet-300/70"
      title="Drag to resize column" />
  );
}

// ---- Manager overview (computed over ALL days, not just the selected one) ---

function ManagerStrip({ all, onPickTech, unassigned }: { all: Row[]; onPickTech: (t: string) => void; unassigned: number }) {
  const pending = all.filter((r) => r.status === "Pending");
  const meetings = all.filter((r) => r.status === "Meeting");
  const worked = all.filter((r) => r.status !== "Pending");
  const hotUntouched = pending.filter((r) => score(r) >= 85);
  const collisions = all.filter(collision);
  const contractReady = pending.filter(contractOk);
  // Untouched leads older than 2 days are rotting — pain doesn't wait.
  const today = new Date().toISOString().slice(0, 10);
  const rotting = pending.filter((r) => {
    const age = (new Date(today).getTime() - new Date(r.queued_date).getTime()) / 86400_000;
    return age >= 2;
  });

  const KPIS: { label: string; value: number; tone: string; sub?: string }[] = [
    { label: "Unassigned roles", value: unassigned, tone: unassigned ? "text-red-600" : "text-slate-400", sub: "allocate these" },
    { label: "Untouched leads", value: pending.length, tone: "text-slate-900" },
    { label: "Hot & untouched (85+)", value: hotUntouched.length, tone: hotUntouched.length ? "text-red-600" : "text-slate-400", sub: "call these first" },
    { label: "Contract-ready waiting", value: contractReady.length, tone: contractReady.length ? "text-emerald-600" : "text-slate-400" },
    { label: "Rotting (2+ days idle)", value: rotting.length, tone: rotting.length ? "text-amber-600" : "text-slate-400", sub: "pain doesn't wait" },
    { label: "Meetings booked", value: meetings.length, tone: meetings.length ? "text-emerald-600" : "text-slate-400" },
    { label: "⚠ B2B collisions", value: collisions.length, tone: collisions.length ? "text-amber-600" : "text-slate-400" },
  ];

  // Per-vein: total vs worked vs meetings — which tech is producing.
  const byVein = new Map<string, { total: number; worked: number; meetings: number }>();
  for (const r of all) {
    const k = r.detected_stack || "?";
    const v = byVein.get(k) ?? { total: 0, worked: 0, meetings: 0 };
    v.total++;
    if (r.status !== "Pending") v.worked++;
    if (r.status === "Meeting") v.meetings++;
    byVein.set(k, v);
  }
  const veins = [...byVein.entries()].sort((a, b) => b[1].total - a[1].total);
  const maxV = veins[0]?.[1].total || 1;

  return (
    <div className="mb-4 grid gap-3 lg:grid-cols-[2fr_1fr]">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {KPIS.map((k) => (
          <div key={k.label} className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
            <p className={`text-xl font-bold leading-tight ${k.tone}`}>{k.value}</p>
            <p className="font-mono text-[9px] font-semibold uppercase tracking-wider text-slate-500">{k.label}</p>
            {k.sub ? <p className="text-[10px] text-slate-400">{k.sub}</p> : null}
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
        <p className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-slate-500">
          By tech · total / worked / <span className="text-emerald-600">meetings</span> — click to filter
        </p>
        <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
          {veins.map(([k, v]) => (
            <button key={k} onClick={() => onPickTech(k)}
              className="group flex w-full items-center gap-2 text-left" title={`Filter table to ${k}`}>
              <span className="w-28 truncate text-[11px] font-medium text-slate-700 group-hover:text-violet-700">{k}</span>
              <span className="relative h-3 flex-1 overflow-hidden rounded bg-slate-100">
                <span className="absolute inset-y-0 left-0 rounded bg-violet-200" style={{ width: `${(v.total / maxV) * 100}%` }} />
                <span className="absolute inset-y-0 left-0 rounded bg-violet-400" style={{ width: `${(v.worked / maxV) * 100}%` }} />
                <span className="absolute inset-y-0 left-0 rounded bg-emerald-500" style={{ width: `${(v.meetings / maxV) * 100}%` }} />
              </span>
              <span className="w-14 text-right font-mono text-[10px] text-slate-500">
                {v.total}/{v.worked}/<span className="text-emerald-600">{v.meetings}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function StaffingBoard({ onExit }: { onExit: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [allRows, setAllRows] = useState<Row[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [dateCounts, setDateCounts] = useState<Record<string, number>>({});
  const [date, setDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [techSel, setTechSel] = useState<string[]>([]);   // empty = all tech
  const [techOpen, setTechOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [owner, setOwner] = useState("");             // table filter: "", "unassigned", or a name
  const [sdrs, setSdrs] = useState<{ id: number; name: string; email: string; active: number }[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<"score" | "days">("score");
  const [sortDesc, setSortDesc] = useState(true);
  // Resizable columns: widths in px, drag the right edge of any header.
  // Persisted per browser so each SDR keeps their own layout.
  const [colW, setColW] = useState<number[]>(COL_DEFAULTS);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("staffing-col-widths") || "null");
      if (Array.isArray(saved) && saved.length === COL_DEFAULTS.length) setColW(saved);
    } catch { /* corrupt storage — keep defaults */ }
  }, []);
  const startResize = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colW[i];
    const onMove = (ev: MouseEvent) => {
      setColW((w) => {
        const n = [...w];
        n[i] = Math.max(60, startW + (ev.clientX - startX));
        return n;
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setColW((w) => {
        try { localStorage.setItem("staffing-col-widths", JSON.stringify(w)); } catch {}
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);

  const load = useCallback(async (d?: string | null, from?: string, to?: string) => {
    setLoading(true);
    const params = new URLSearchParams({ market: "staffing" });
    if (from || to) {
      // Date-range mode (inclusive; either bound optional) — the API scopes
      // rows to the range and the day navigator is ignored.
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    } else if (d) params.set("date", d);
    const res = await fetch(`/api/outbound?${params}`);
    const data = await res.json();
    setRows(data.rows || []);
    setDates(data.dates || []);
    setDateCounts(data.dateCounts || {});
    setDate(data.date || null);
    setLoading(false);
    // Manager strip aggregates across ALL days (cheap: staffing is ≤25/day).
    const allRes = await fetch(`/api/outbound?market=staffing&all=1`);
    const allData = await allRes.json();
    setAllRows(allData.rows || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadSdrs = useCallback(async () => {
    const res = await fetch("/api/sdrs");
    if (res.ok) setSdrs((await res.json()).sdrs || []);
  }, []);
  useEffect(() => {
    loadSdrs();
  }, [loadSdrs]);
  const activeSdrNames = useMemo(
    () => sdrs.filter((s) => s.active).map((s) => s.name),
    [sdrs],
  );
  const assignTargets = useMemo(() => ["Ajay", ...activeSdrNames], [activeSdrNames]);

  const patch = async (r: Row, fields: Record<string, string>) => {
    setSaving(r.id);
    const res = await fetch("/api/outbound", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id, fields }),
    });
    const data = await res.json();
    if (data.row) {
      setRows((rs) => rs.map((x) => (x.id === r.id ? data.row : x)));
      setAllRows((rs) => rs.map((x) => (x.id === r.id ? data.row : x)));
    }
    setSaving(null);
  };

  // Tech options come from ALL days so the multi-select is stable even when
  // the selected day happens to miss a vein.
  const techs = useMemo(
    () => Array.from(new Set(allRows.map((r) => r.detected_stack || ""))).filter(Boolean).sort(),
    [allRows],
  );

  const toggleTech = (t: string) =>
    setTechSel((sel) => (sel.includes(t) ? sel.filter((x) => x !== t) : [...sel, t]));

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => (techSel.length === 0 || techSel.includes(r.detected_stack || "")))
      .filter((r) => !owner || (owner === "unassigned" ? !r.sdr : r.sdr === owner))
      .filter((r) => (!status || r.status === status))
      .filter(
        (r) =>
          !needle ||
          `${r.company} ${role(r)} ${r.first_name} ${r.last_name} ${r.title}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        const va = sortKey === "score" ? score(a) : daysOpen(a) ?? -1;
        const vb = sortKey === "score" ? score(b) : daysOpen(b) ?? -1;
        return sortDesc ? vb - va : va - vb;
      });
  }, [rows, techSel, status, q, sortKey, sortDesc, owner]);

  // Role-driven grouping: one visual row per (company, role); extra contacts
  // ride along and show in the expanded Contact panel. Status is per-role —
  // changing it updates every contact row underneath.
  const groups = useMemo(() => {
    const seen = new Map<string, { main: Row; others: Row[] }>();
    for (const r of visible) {
      const k = `${(r.company || "").toLowerCase()}|${role(r).toLowerCase()}`;
      const g = seen.get(k);
      if (!g) seen.set(k, { main: r, others: [] });
      else if (!g.main.verified_email && r.verified_email) {
        seen.set(k, { main: r, others: [g.main, ...g.others] }); // best-reachable contact leads
      } else g.others.push(r);
    }
    return [...seen.values()];
  }, [visible]);

  const toggleSort = (k: "score" | "days") => {
    if (sortKey === k) setSortDesc((d) => !d);
    else {
      setSortKey(k);
      setSortDesc(true);
    }
  };
  const arrow = (k: "score" | "days") => (sortKey === k ? (sortDesc ? " ▼" : " ▲") : "");

  const exportCsv = () => {
    const esc = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Score", "Role", "Tech", "Company", "Size", "Industry", "Days Open", "Contract OK",
      "Budget", "Contact", "Title", "Email", "LinkedIn", "Posting URL", "Status", "B2B Collision", "Why"];
    const lines = visible.map((r) => [
      score(r), role(r), r.detected_stack, r.company, r.size, r.bucket, daysOpen(r) ?? "",
      contractOk(r) ? "Yes" : "", budget(r), `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      r.title, r.verified_email, r.linkedin, r.source_url, r.status,
      collision(r) ? "Yes" : "", reasons(r),
    ].map(esc).join(","));
    const blob = new Blob(["﻿" + [head.map(esc).join(","), ...lines].join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `staffing-roles-${date ?? "all"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(124,58,237,0.10),transparent)] text-slate-800">
      <div className="mx-auto max-w-[1400px] p-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              🧑‍💼 Staffing <span className="text-base font-semibold text-violet-600">· open roles at unique clients</span>
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              call-first · hottest pain on top · every company appears once, ever
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCsv}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900">
              ⬇ Export CSV
            </button>
            <button onClick={onExit}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900">
              ⇄ Regions
            </button>
            <a href="/"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900">
              ← Dashboard
            </a>
          </div>
        </header>

        {/* Manager overview — all days, live-updating with status changes */}
        <ManagerStrip all={allRows} onPickTech={(t) => { setTechSel([t]); setStatus(""); }}
          unassigned={(() => {
            const seen = new Set<string>();
            for (const r of allRows) {
              if (!r.sdr && r.status === "Pending") seen.add(`${(r.company || "").toLowerCase()}|${role(r).toLowerCase()}`);
            }
            return seen.size;
          })()} />

        {/* Day navigator + filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select value={rangeFrom || rangeTo ? "" : date ?? ""}
            onChange={(e) => { setRangeFrom(""); setRangeTo(""); load(e.target.value); }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm">
            {(rangeFrom || rangeTo) && <option value="">date range ↓</option>}
            {dates.map((d) => (
              <option key={d} value={d}>{d} · {dateCounts[d] ?? 0} roles</option>
            ))}
          </select>
          {/* Date range: set either bound; loads the API's from/to mode */}
          <span className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs shadow-sm">
            <input type="date" value={rangeFrom}
              onChange={(e) => { setRangeFrom(e.target.value); load(null, e.target.value, rangeTo); }}
              className="bg-transparent text-slate-600" title="From date" />
            <span className="text-slate-400">→</span>
            <input type="date" value={rangeTo}
              onChange={(e) => { setRangeTo(e.target.value); load(null, rangeFrom, e.target.value); }}
              className="bg-transparent text-slate-600" title="To date" />
            {(rangeFrom || rangeTo) && (
              <button onClick={() => { setRangeFrom(""); setRangeTo(""); load(); }}
                className="ml-1 font-bold text-slate-400 hover:text-red-500" title="Clear range">✕</button>
            )}
          </span>
          {/* Multi-select tech filter */}
          <span className="relative">
            <button onClick={() => setTechOpen((o) => !o)}
              className={`rounded-lg border px-3 py-1.5 text-sm shadow-sm transition ${techSel.length ? "border-violet-400 bg-violet-50 text-violet-700" : "border-slate-300 bg-white text-slate-600"}`}>
              {techSel.length === 0 ? "All tech" : techSel.length === 1 ? techSel[0] : `${techSel.length} techs`} ▾
            </button>
            {techOpen && (
              <span className="absolute left-0 top-full z-20 mt-1 block max-h-64 w-56 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
                <button onClick={() => setTechSel([])}
                  className="mb-1 block w-full rounded px-2 py-1 text-left text-xs font-semibold text-slate-500 hover:bg-slate-100">
                  Clear — show all
                </button>
                {techs.map((t) => (
                  <label key={t} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-slate-700 hover:bg-violet-50">
                    <input type="checkbox" checked={techSel.includes(t)} onChange={() => toggleTech(t)}
                      className="accent-violet-600" />
                    <span className="truncate">{t}</span>
                  </label>
                ))}
              </span>
            )}
          </span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}
            className={`rounded-lg border px-3 py-1.5 text-sm shadow-sm ${owner ? "border-violet-400 bg-violet-50 text-violet-700" : "border-slate-300 bg-white"}`}>
            <option value="">All owners</option>
            <option value="unassigned">Unassigned</option>
            {assignTargets.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <a href="/outbound/team"
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 shadow-sm transition hover:border-slate-400">
            👥 Team
          </a>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="⌕ role, company, contact…"
            className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm" />
          <span className="ml-auto text-xs text-slate-500">{groups.length} role(s)</span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm" style={{ tableLayout: "fixed", minWidth: colW.reduce((a, b) => a + b, 0) }}>
            <colgroup>
              {colW.map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left font-mono text-[10px] uppercase tracking-wider text-slate-500">
                {[
                  { label: <>Score{arrow("score")}</>, sort: "score" as const, right: false },
                  { label: <>Open role</> },
                  { label: <>Tech</> },
                  { label: <>Company</> },
                  { label: <>Days open{arrow("days")}</>, sort: "days" as const, right: true },
                  { label: <>Contract</> },
                  { label: <>Budget</> },
                  { label: <>Contact</> },
                  { label: <>Owner</> },
                  { label: <>Status</> },
                ].map((h, i) => (
                  <th key={i}
                    onClick={h.sort ? () => toggleSort(h.sort) : undefined}
                    title={h.sort ? "Click to sort · drag edge to resize" : "Drag edge to resize"}
                    className={`relative select-none px-3 py-2.5 ${h.right ? "text-right" : ""} ${h.sort ? "cursor-pointer text-violet-700 hover:text-violet-900" : ""}`}>
                    {h.label}
                    <ResizeHandle onMouseDown={(e) => startResize(i, e)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">Loading…</td></tr>
              )}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">
                  No roles yet — the agent delivers up to 25 unique clients nightly.
                </td></tr>
              )}
              {groups.map(({ main: r, others }) => {
                const d = daysOpen(r);
                const isOpen = open === r.id;
                return (
                  <FragmentRow key={r.id} r={r} others={others} d={d} isOpen={isOpen}
                    assignTargets={assignTargets}
                    onAssign={(who) => { patch(r, { sdr: who }); others.forEach((o) => patch(o, { sdr: who })); }}
                    onToggle={() => setOpen(isOpen ? null : r.id)}
                    onStatus={(s) => { patch(r, { status: s }); others.forEach((o) => patch(o, { status: s })); }}
                    notes={notes[r.id] ?? r.rep_notes ?? ""}
                    setNote={(v) => setNotes((n) => ({ ...n, [r.id]: v }))}
                    saveNote={() => patch(r, { rep_notes: notes[r.id] ?? "" })}
                    saving={saving === r.id}
                  />
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">
          ⚠ = this company is also in the B2B email pipeline — coordinate with the campaign team before calling.
        </p>

      </div>
    </div>
  );
}

function FragmentRow({ r, others = [], d, isOpen, assignTargets, onAssign, onToggle, onStatus, notes, setNote, saveNote, saving }: {
  r: Row; others?: Row[]; d: number | null; isOpen: boolean;
  assignTargets: string[]; onAssign: (who: string) => void;
  onToggle: () => void; onStatus: (s: string) => void;
  notes: string; setNote: (v: string) => void; saveNote: () => void; saving: boolean;
}) {
  const s = score(r);
  return (
    <>
      <tr onClick={onToggle}
        className={`cursor-pointer border-b border-slate-100 transition hover:bg-violet-50/40 ${collision(r) ? "bg-amber-50/60" : ""}`}>
        <td className="px-3 py-2.5">
          <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${scoreTone(s)}`}>{s}</span>
        </td>
        <td className="max-w-[240px] px-3 py-2.5">
          <div className="truncate font-semibold text-slate-800">{role(r)}</div>
          {collision(r) && <div className="text-[10px] font-semibold text-amber-600">⚠ in B2B email pipeline</div>}
        </td>
        <td className="px-3 py-2.5">
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase text-violet-700 ring-1 ring-violet-200">
            {r.detected_stack}
          </span>
        </td>
        <td className="max-w-[200px] px-3 py-2.5">
          <div className="truncate font-medium text-slate-800">{r.company}</div>
          <div className="truncate text-[11px] text-slate-400">{r.size ? `${r.size} emp` : ""}{r.bucket ? ` · ${r.bucket}` : ""}</div>
        </td>
        <td className="px-3 py-2.5 text-right">
          <span className={`font-bold ${d != null && d >= 60 ? "text-red-600" : d != null && d >= 30 ? "text-amber-600" : "text-slate-600"}`}>
            {d ?? "—"}
          </span>
        </td>
        <td className="px-3 py-2.5">{contractOk(r) ? <span className="font-semibold text-emerald-600">Yes</span> : <span className="text-slate-300">—</span>}</td>
        <td className="max-w-[130px] truncate px-3 py-2.5 text-slate-600">{budget(r) || <span className="text-slate-300">—</span>}</td>
        <td className="max-w-[190px] px-3 py-2.5">
          <div className="truncate font-medium text-slate-800">
            {r.first_name ? `${r.first_name} ${r.last_name ?? ""}` : <span className="text-slate-400">(hunt on LinkedIn)</span>}
            {others.length > 0 && <span className="ml-1 text-[10px] font-semibold text-violet-600">+{others.length} more</span>}
          </div>
          <div className="truncate text-[11px] text-slate-400">{r.title}</div>
        </td>
        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
          <select value={r.sdr ?? ""} onChange={(e) => onAssign(e.target.value)} disabled={saving}
            className={`w-full rounded-md border-0 px-2 py-1 text-xs font-semibold ${r.sdr ? "bg-sky-100 text-sky-700" : "bg-red-50 text-red-500"}`}>
            <option value="">— assign —</option>
            {assignTargets.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </td>
        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
          <select value={r.status} onChange={(e) => onStatus(e.target.value)} disabled={saving}
            className={`rounded-md border-0 px-2 py-1 text-xs font-semibold ${STATUS_META[r.status] ?? STATUS_META.Pending}`}>
            {STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-slate-100 bg-slate-50/60">
          <td colSpan={10} className="px-5 py-4">
            <div className="grid gap-4 lg:grid-cols-4">
              {/* CONTACT — exclusive panel: every contact for this role, every channel */}
              <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-violet-600">
                  📇 Contact{others.length > 0 ? `s (${others.length + 1})` : ""}
                </p>
                {[r, ...others].map((c, i) => (
                  <div key={c.id} className={i > 0 ? "mt-3 border-t border-violet-200/70 pt-2.5" : ""}>
                    <p className="mt-1.5 text-sm font-bold text-slate-900">
                      {c.first_name ? `${c.first_name} ${c.last_name ?? ""}` : "(no contact — hunt on LinkedIn)"}
                    </p>
                    <p className="text-xs text-slate-500">{c.title || ""}</p>
                    <div className="mt-2 space-y-1.5 text-xs">
                      <p className="flex items-center gap-1.5">
                        <span>📞</span>
                        {c.phone
                          ? <a href={`tel:${c.phone}`} className="font-semibold text-slate-800 hover:text-violet-700">{c.phone} <span className="font-normal text-slate-400">(company line)</span></a>
                          : <span className="text-slate-400">no number on file</span>}
                      </p>
                      <p className="flex items-center gap-1.5">
                        <span>✉</span>
                        {c.verified_email
                          ? <>
                              <button onClick={() => navigator.clipboard.writeText(c.verified_email!)}
                                className="truncate font-semibold text-slate-800 hover:text-violet-700" title="Click to copy">
                                {c.verified_email}
                              </button>
                              {c.email_1 && (
                                <a href={`mailto:${c.verified_email}?subject=${encodeURIComponent(`your ${role(c)} opening`)}&body=${encodeURIComponent(c.email_1)}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="shrink-0 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-violet-700"
                                  title={`Compose to ${c.first_name} with their personalized draft`}>
                                  ✉ compose
                                </a>
                              )}
                            </>
                          : <span className="text-slate-400">no email</span>}
                      </p>
                      <p className="flex items-center gap-1.5">
                        <span>in</span>
                        {c.linkedin
                          ? <a href={c.linkedin.startsWith("http") ? c.linkedin : `https://${c.linkedin}`}
                              target="_blank" rel="noreferrer"
                              className="truncate font-semibold text-violet-600 underline decoration-violet-300 hover:text-violet-800">
                              {c.linkedin.replace(/^https?:\/\/(www\.)?linkedin\.com\/(in\/)?/, "")}
                            </a>
                          : <span className="text-slate-400">no profile</span>}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">Why this lead</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-700">{reasons(r) || "—"}</p>
                {r.source_url && (
                  <a href={r.source_url.startsWith("http") ? r.source_url : `https://${r.source_url}`}
                    target="_blank" rel="noreferrer" className="mt-2 block truncate text-xs text-violet-600 underline decoration-violet-300 hover:text-violet-800">
                    ↗ View the posting (verify before calling)
                  </a>
                )}
              </div>
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">Call opener</p>
                <p className="mt-1 whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-700">{r.subject || "—"}</p>
              </div>
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">Email draft (fallback)</p>
                <p className="mt-1 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-700">{r.email_1 || "—"}</p>
                {r.email_1 && (
                  <div className="mt-2 flex gap-2">
                    {r.verified_email && (
                      <a href={`mailto:${r.verified_email}?subject=${encodeURIComponent(`your ${role(r)} opening`)}&body=${encodeURIComponent(r.email_1)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700">
                        ✉ Open in email app
                      </a>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(r.email_1!); }}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-slate-400"
                      title="Copy the draft text">
                      ⧉ Copy draft
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input value={notes} onChange={(e) => setNote(e.target.value)} placeholder="SDR notes…"
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs shadow-sm" />
              <button onClick={saveNote} disabled={saving}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-50">
                {saving ? "Saving…" : "Save note"}
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
