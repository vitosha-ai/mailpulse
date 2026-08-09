"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// SDR call desk — the ONLY page an SDR access code opens. Shows the leads
// assigned to that SDR with just the calling surface: company, role, days
// open, contacts (phone/email/LinkedIn), opener, email draft, status, notes,
// and a transfer control (back to the manager or to another SDR). No scores,
// no ranking reasons, no agent mechanics — those never leave the server.

type Lead = {
  id: number;
  queued_date: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  verified_email: string | null;
  linkedin: string | null;
  phone: string | null;
  company: string | null;
  trigger_detail: string | null; // sanitized server-side: role · days · contract · budget
  source_url: string | null;
  bucket: string | null;
  detected_stack: string | null;
  subject: string | null;
  email_1: string | null;
  status: string;
  rep_notes: string | null;
  size: string | null;
  market: string;
};

const MARKET_BADGE: Record<string, string> = {
  us: "bg-slate-100 text-slate-500",
  gcc: "bg-teal-100 text-teal-700",
  staffing: "bg-violet-100 text-violet-700",
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

const roleOf = (l: Lead) => (l.trigger_detail || "").split(" — ")[0] || l.detected_stack || "";
const daysOf = (l: Lead) => {
  const m = /open (\d+) day/.exec(l.trigger_detail || "");
  return m ? Number(m[1]) : null;
};

export default function CallsPage() {
  const [me, setMe] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [loginErr, setLoginErr] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/calls");
    if (res.status === 401) {
      setMe(null);
      setChecked(true);
      return;
    }
    const data = await res.json();
    setMe(data.me);
    setLeads(data.leads || []);
    setTargets(data.transferTargets || []);
    setChecked(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const requestOtp = async () => {
    setLoginErr("");
    const res = await fetch("/api/calls/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    if (!res.ok) {
      setLoginErr("Couldn't send a code right now — try again in a minute.");
      return;
    }
    setOtpSent(true);
  };

  const verifyOtp = async () => {
    setLoginErr("");
    const res = await fetch("/api/calls/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), otp: otp.trim() }),
    });
    if (!res.ok) {
      setLoginErr("That code didn't work or expired — request a new one.");
      return;
    }
    await load();
  };

  const patch = async (id: number, fields: Record<string, string>) => {
    const res = await fetch("/api/calls", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...fields }),
    });
    if (res.ok) {
      if (fields.transfer_to) setLeads((ls) => ls.filter((l) => l.id !== id));
      else
        setLeads((ls) =>
          ls.map((l) => (l.id === id ? { ...l, ...(fields as Partial<Lead>) } : l)),
        );
    }
  };

  // One card per (company, role); extra contacts grouped inside.
  const groups = useMemo(() => {
    const seen = new Map<string, { main: Lead; others: Lead[] }>();
    const pool = statusFilter ? leads.filter((l) => l.status === statusFilter) : leads;
    for (const l of pool) {
      const k = `${l.market}|${(l.company || "").toLowerCase()}|${roleOf(l).toLowerCase()}`;
      const g = seen.get(k);
      if (!g) seen.set(k, { main: l, others: [] });
      else if (!g.main.verified_email && l.verified_email) seen.set(k, { main: l, others: [g.main, ...g.others] });
      else g.others.push(l);
    }
    return [...seen.values()].sort((a, b) => (daysOf(b.main) ?? 0) - (daysOf(a.main) ?? 0));
  }, [leads, statusFilter]);

  if (!checked) return <div className="p-10 text-center text-slate-400">Loading…</div>;

  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-bold text-slate-900">📞 Vitosha Call Desk</h1>
          {!otpSent ? (
            <>
              <p className="mt-1 text-sm text-slate-500">Enter your work email — we'll send you a one-time login code.</p>
              <input value={email} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && requestOtp()}
                placeholder="you@company.com" type="email" autoFocus
                className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              {loginErr && <p className="mt-2 text-xs text-red-600">{loginErr}</p>}
              <button onClick={requestOtp} disabled={!email.trim()}
                className="mt-4 w-full rounded-lg bg-violet-600 py-2 font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50">
                Email me a code
              </button>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-slate-500">
                If <b>{email}</b> is invited, a 6-digit code is on its way. Enter it below (valid 10 minutes).
              </p>
              <input value={otp} onChange={(e) => setOtp(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && verifyOtp()}
                placeholder="123456" inputMode="numeric" autoFocus
                className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-center font-mono text-lg tracking-[0.4em]" />
              {loginErr && <p className="mt-2 text-xs text-red-600">{loginErr}</p>}
              <button onClick={verifyOtp} disabled={!otp.trim()}
                className="mt-4 w-full rounded-lg bg-violet-600 py-2 font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50">
                Open my leads
              </button>
              <button onClick={() => { setOtpSent(false); setOtp(""); }}
                className="mt-2 w-full text-xs text-slate-400 hover:text-slate-600">
                ← different email / resend
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(124,58,237,0.10),transparent)] text-slate-800">
      <div className="mx-auto max-w-4xl p-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">📞 Call Desk · {me}</h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              your assigned roles · longest-open first · call, log, move on
            </p>
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </header>

        {groups.length === 0 && (
          <p className="mt-16 text-center text-slate-400">
            No leads assigned{statusFilter ? " with that status" : ""} — check back after your manager allocates today's list.
          </p>
        )}

        <div className="space-y-3">
          {groups.map(({ main: l, others }) => {
            const d = daysOf(l);
            const isOpen = open === l.id;
            return (
              <div key={l.id}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <button onClick={() => setOpen(isOpen ? null : l.id)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-violet-50/40">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-slate-900">
                      <span className={`mr-1.5 rounded px-1.5 py-0.5 align-middle text-[9px] font-bold uppercase ${MARKET_BADGE[l.market] ?? MARKET_BADGE.us}`}>
                        {l.market === "staffing" ? "Staffing" : l.market.toUpperCase()}
                      </span>
                      {roleOf(l)}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {l.company}{l.size ? ` · ${l.size} emp` : ""}{l.bucket ? ` · ${l.bucket}` : ""}
                    </p>
                  </div>
                  {d != null && (
                    <span className={`text-sm font-bold ${d >= 60 ? "text-red-600" : d >= 30 ? "text-amber-600" : "text-slate-500"}`}>
                      {d}d open
                    </span>
                  )}
                  <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_META[l.status] ?? STATUS_META.Pending}`}>
                    {l.status}
                  </span>
                  <span className="text-slate-300">{isOpen ? "▲" : "▼"}</span>
                </button>

                {isOpen && (
                  <div className="border-t border-slate-100 px-4 py-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
                        <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-violet-600">
                          📇 Contact{others.length ? `s (${others.length + 1})` : ""}
                        </p>
                        {[l, ...others].map((c, i) => (
                          <div key={c.id} className={i > 0 ? "mt-3 border-t border-violet-200/70 pt-2.5" : ""}>
                            <p className="mt-1 text-sm font-bold text-slate-900">
                              {c.first_name ? `${c.first_name} ${c.last_name ?? ""}` : "(no contact on file)"}
                            </p>
                            <p className="text-xs text-slate-500">{c.title}</p>
                            <div className="mt-1.5 space-y-1 text-xs">
                              <p>📞 {c.phone
                                ? <a href={`tel:${c.phone}`} className="font-semibold hover:text-violet-700">{c.phone} <span className="font-normal text-slate-400">(company line)</span></a>
                                : <span className="text-slate-400">no number</span>}</p>
                              <p>✉ {c.verified_email
                                ? <button onClick={() => navigator.clipboard.writeText(c.verified_email!)}
                                    className="font-semibold hover:text-violet-700" title="Click to copy">{c.verified_email}</button>
                                : <span className="text-slate-400">no email</span>}</p>
                              <p>in {c.linkedin
                                ? <a href={c.linkedin.startsWith("http") ? c.linkedin : `https://${c.linkedin}`}
                                    target="_blank" rel="noreferrer"
                                    className="font-semibold text-violet-600 underline decoration-violet-300">
                                    {c.linkedin.replace(/^https?:\/\/(www\.)?linkedin\.com\/(in\/)?/, "")}
                                  </a>
                                : <span className="text-slate-400">no profile</span>}</p>
                            </div>
                          </div>
                        ))}
                        {l.source_url && (
                          <a href={l.source_url.startsWith("http") ? l.source_url : `https://${l.source_url}`}
                            target="_blank" rel="noreferrer"
                            className="mt-3 block truncate text-xs text-violet-600 underline decoration-violet-300">
                            ↗ View the job posting
                          </a>
                        )}
                      </div>
                      <div className="space-y-3">
                        <div>
                          <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                            {l.market === "staffing" ? "Call opener" : "Email subject"}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs leading-relaxed">{l.subject || "—"}</p>
                        </div>
                        <div>
                          <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">Email draft</p>
                          <p className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs leading-relaxed">{l.email_1 || "—"}</p>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {STATUSES.filter((s) => s !== "Pending").map((s) => (
                        <button key={s}
                          onClick={() => { patch(l.id, { status: s }); others.forEach((o) => patch(o.id, { status: s })); }}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${l.status === s ? STATUS_META[s] + " ring-2 ring-violet-300" : "bg-white ring-1 ring-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                          {s === "Meeting" ? "🎯 Meeting" : s}
                        </button>
                      ))}
                      <select value="" onChange={(e) => {
                          const to = e.target.value;
                          if (to && confirm(`Transfer this lead to ${to}?`)) {
                            patch(l.id, { transfer_to: to });
                            others.forEach((o) => patch(o.id, { transfer_to: to }));
                          }
                        }}
                        className="ml-auto rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-600 shadow-sm">
                        <option value="">↪ Transfer to…</option>
                        {targets.map((t) => <option key={t} value={t}>{t === "Ajay" ? "Ajay (manager)" : t}</option>)}
                      </select>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <input value={notes[l.id] ?? l.rep_notes ?? ""}
                        onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))}
                        placeholder="Your notes on this lead…"
                        className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs shadow-sm" />
                      <button onClick={() => patch(l.id, { rep_notes: notes[l.id] ?? "" })}
                        className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700">
                        Save note
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
