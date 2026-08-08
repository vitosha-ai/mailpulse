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

export default function StaffingBoard({ onExit }: { onExit: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [dateCounts, setDateCounts] = useState<Record<string, number>>({});
  const [date, setDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tech, setTech] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);

  const load = useCallback(async (d?: string | null) => {
    setLoading(true);
    const params = new URLSearchParams({ market: "staffing" });
    if (d) params.set("date", d);
    const res = await fetch(`/api/outbound?${params}`);
    const data = await res.json();
    setRows(data.rows || []);
    setDates(data.dates || []);
    setDateCounts(data.dateCounts || {});
    setDate(data.date || null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (r: Row, fields: Record<string, string>) => {
    setSaving(r.id);
    const res = await fetch("/api/outbound", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id, fields }),
    });
    const data = await res.json();
    if (data.row) setRows((rs) => rs.map((x) => (x.id === r.id ? data.row : x)));
    setSaving(null);
  };

  const techs = useMemo(
    () => Array.from(new Set(rows.map((r) => r.detected_stack || ""))).filter(Boolean).sort(),
    [rows],
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => (!tech || r.detected_stack === tech))
      .filter((r) => (!status || r.status === status))
      .filter(
        (r) =>
          !needle ||
          `${r.company} ${role(r)} ${r.first_name} ${r.last_name} ${r.title}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => score(b) - score(a));
  }, [rows, tech, status, q]);

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

        {/* Day navigator + filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select value={date ?? ""} onChange={(e) => load(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm">
            {dates.map((d) => (
              <option key={d} value={d}>{d} · {dateCounts[d] ?? 0} roles</option>
            ))}
          </select>
          <select value={tech} onChange={(e) => setTech(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm">
            <option value="">All tech</option>
            {techs.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="⌕ role, company, contact…"
            className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm" />
          <span className="ml-auto text-xs text-slate-500">{visible.length} role(s)</span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left font-mono text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2.5">Score</th>
                <th className="px-3 py-2.5">Open role</th>
                <th className="px-3 py-2.5">Tech</th>
                <th className="px-3 py-2.5">Company</th>
                <th className="px-3 py-2.5 text-right">Days open</th>
                <th className="px-3 py-2.5">Contract</th>
                <th className="px-3 py-2.5">Budget</th>
                <th className="px-3 py-2.5">Contact</th>
                <th className="px-3 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-slate-400">Loading…</td></tr>
              )}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-slate-400">
                  No roles yet — the agent delivers up to 25 unique clients nightly.
                </td></tr>
              )}
              {visible.map((r) => {
                const d = daysOpen(r);
                const isOpen = open === r.id;
                return (
                  <FragmentRow key={r.id} r={r} d={d} isOpen={isOpen}
                    onToggle={() => setOpen(isOpen ? null : r.id)}
                    onStatus={(s) => patch(r, { status: s })}
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

function FragmentRow({ r, d, isOpen, onToggle, onStatus, notes, setNote, saveNote, saving }: {
  r: Row; d: number | null; isOpen: boolean;
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
          </div>
          <div className="truncate text-[11px] text-slate-400">{r.title}</div>
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
          <td colSpan={9} className="px-5 py-4">
            <div className="grid gap-4 lg:grid-cols-3">
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">Why this lead</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-700">{reasons(r) || "—"}</p>
                <div className="mt-3 space-y-1 text-xs">
                  {r.source_url && (
                    <a href={r.source_url.startsWith("http") ? r.source_url : `https://${r.source_url}`}
                      target="_blank" rel="noreferrer" className="block truncate text-violet-600 underline decoration-violet-300 hover:text-violet-800">
                      ↗ View the posting (verify before calling)
                    </a>
                  )}
                  {r.verified_email && <p className="text-slate-600">✉ {r.verified_email}</p>}
                  {r.linkedin && (
                    <a href={r.linkedin.startsWith("http") ? r.linkedin : `https://${r.linkedin}`}
                      target="_blank" rel="noreferrer" className="block truncate text-violet-600 underline decoration-violet-300 hover:text-violet-800">
                      in/ {r.linkedin.replace(/^https?:\/\/(www\.)?linkedin\.com\/(in\/)?/, "")}
                    </a>
                  )}
                </div>
              </div>
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">Call opener</p>
                <p className="mt-1 whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-700">{r.subject || "—"}</p>
              </div>
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">Email draft (fallback)</p>
                <p className="mt-1 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-700">{r.email_1 || "—"}</p>
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
