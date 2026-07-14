"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Row = {
  id: number;
  queued_date: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  verified_email: string | null;
  linkedin: string | null;
  company: string | null;
  trigger_type: string | null;
  trigger_detail: string | null;
  trigger_date: string | null;
  source_url: string | null;
  bucket: string | null;
  detected_stack: string | null;
  pillar: string | null;
  proof_point: string | null;
  subject: string | null;
  email_1: string | null;
  followup_day_3: string | null;
  followup_day_8: string | null;
  breakup_day_15: string | null;
  confidence: string | null;
  status: string;
  rep_notes: string | null;
  size: string | null;
  researched_at: string | null;
  fit_reason: string | null;
  research_trail: string | null;
};

const STATUSES = ["Pending", "Verified", "Edited", "Sent", "Rejected", "Skipped"] as const;

const CONF_META: Record<string, { dot: string; text: string }> = {
  High: { dot: "bg-emerald-500", text: "text-emerald-600" },
  Medium: { dot: "bg-amber-500", text: "text-amber-700" },
  Low: { dot: "bg-red-500", text: "text-red-700" },
};

const STATUS_META: Record<string, string> = {
  Pending: "bg-slate-100 text-slate-600",
  Verified: "bg-blue-100 text-blue-700",
  Edited: "bg-violet-100 text-violet-700",
  Sent: "bg-emerald-100 text-emerald-700",
  Rejected: "bg-red-100 text-red-700",
  Skipped: "bg-slate-100 text-slate-400",
};

const DRAFT_FIELDS = [
  { key: "subject", label: "Subject" },
  { key: "email_1", label: "Email 1" },
  { key: "followup_day_3", label: "Follow-up · Day 3" },
  { key: "followup_day_8", label: "Follow-up · Day 8" },
  { key: "breakup_day_15", label: "Breakup · Day 15" },
] as const;

type CostAgg = {
  runs: number;
  apollo_credits: number;
  apollo_cost_usd: number;
  anthropic_tokens: number;
  anthropic_cost_usd: number;
  apify_runs: number;
  apify_cost_usd: number;
  total_cost_usd: number;
};

type Costs = {
  today: CostAgg;
  week: CostAgg;
  month: CostAgg;
  allTime: CostAgg;
  daily: { run_date: string; apollo_credits: number; total_cost_usd: number; runs: number }[];
};

const usd = (n: number) => `$${(n ?? 0).toFixed(2)}`;
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n ?? 0}`;

function CostCard({ label, agg }: { label: string; agg: CostAgg }) {
  return (
    <div className="flex-1 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</p>
        <p className="text-lg font-bold text-slate-900">{usd(agg.total_cost_usd)}</p>
      </div>
      <div className="mt-2 space-y-1 text-xs text-slate-600">
        <div className="flex justify-between">
          <span>Apollo · {compact(agg.apollo_credits)} credits</span>
          <span className="font-medium text-slate-800">{usd(agg.apollo_cost_usd)}</span>
        </div>
        <div className="flex justify-between">
          <span>Claude · {compact(agg.anthropic_tokens)} tok</span>
          <span className="font-medium text-slate-800">{usd(agg.anthropic_cost_usd)}</span>
        </div>
        <div className="flex justify-between">
          <span>Apify · {agg.apify_runs} runs</span>
          <span className="font-medium text-slate-800">{usd(agg.apify_cost_usd)}</span>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">{agg.runs} agent run{agg.runs === 1 ? "" : "s"}</p>
    </div>
  );
}

function hasProofToken(r: Partial<Row>): boolean {
  return DRAFT_FIELDS.some((f) => (r[f.key] as string | null | undefined)?.includes("[PROOF:"));
}

export default function Outbound() {
  const [date, setDate] = useState<string | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [edits, setEdits] = useState<Record<number, Partial<Row>>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [costs, setCosts] = useState<Costs | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async (d?: string | null, status?: string) => {
    const params = new URLSearchParams();
    if (d) params.set("date", d);
    if (status) params.set("status", status);
    const res = await fetch(`/api/outbound?${params}`);
    const data = await res.json();
    setDate(data.date);
    setDates(data.dates);
    setRows(data.rows);
    setCounts(data.counts);
  }, []);

  useEffect(() => {
    load(date, statusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  useEffect(() => {
    fetch("/api/outbound/costs")
      .then((r) => r.json())
      .then(setCosts)
      .catch(() => setCosts(null));
  }, []);

  const merged = useCallback((r: Row): Row => ({ ...r, ...edits[r.id] }), [edits]);

  const setField = (id: number, key: keyof Row, value: string) =>
    setEdits((e) => ({ ...e, [id]: { ...e[id], [key]: value } }));

  const save = async (r: Row, status?: string) => {
    setSaving(r.id);
    const fields: Record<string, string> = {};
    for (const f of DRAFT_FIELDS) fields[f.key] = (merged(r)[f.key] as string) ?? "";
    fields.rep_notes = (merged(r).rep_notes as string) ?? "";
    if (status) fields.status = status;
    const res = await fetch("/api/outbound", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id, fields }),
    });
    const data = await res.json();
    if (data.row) {
      setRows((rs) => rs.map((x) => (x.id === r.id ? data.row : x)));
      setEdits((e) => {
        const n = { ...e };
        delete n[r.id];
        return n;
      });
    }
    setSaving(null);
  };

  const copySequence = (r: Row) => {
    const m = merged(r);
    const text = [
      `To: ${m.verified_email}`,
      `Subject: ${m.subject}`,
      "",
      m.email_1,
      "\n--- Follow-up (Day 3) ---\n",
      m.followup_day_3,
      "\n--- Follow-up (Day 8) ---\n",
      m.followup_day_8,
      "\n--- Breakup (Day 15) ---\n",
      m.breakup_day_15,
    ].join("\n");
    navigator.clipboard.writeText(text);
    setCopied(r.id);
    setTimeout(() => setCopied(null), 1500);
  };

  const total = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-4xl p-6">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              Outbound
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              triggered accounts · researched &amp; drafted nightly · you verify &amp; send
            </p>
          </div>
          <a
            href="/"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
          >
            ← Dashboard
          </a>
        </header>

        {/* Agent spend — Apollo credits + Claude $ (metered per run by the agent) */}
        {costs && (
          <div className="mb-6">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                Agent spend
              </p>
              <button
                onClick={() => setShowHistory((v) => !v)}
                className="text-[11px] font-medium text-brand hover:underline"
              >
                {showHistory ? "hide history" : "daily history"}
              </button>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <CostCard label="Today" agg={costs.today} />
              <CostCard label="Last 7 days" agg={costs.week} />
              <CostCard label="Last 30 days" agg={costs.month} />
            </div>
            {showHistory && (
              <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 text-left font-mono text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="px-4 py-2">Date</th>
                      <th className="px-4 py-2 text-right">Runs</th>
                      <th className="px-4 py-2 text-right">Apollo credits</th>
                      <th className="px-4 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costs.daily.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-3 text-center text-slate-400">
                          No usage recorded yet — appears after the agent&apos;s next run.
                        </td>
                      </tr>
                    )}
                    {costs.daily.map((d) => (
                      <tr key={d.run_date} className="border-b border-slate-50 text-slate-700">
                        <td className="px-4 py-2 font-mono">{d.run_date}</td>
                        <td className="px-4 py-2 text-right">{d.runs}</td>
                        <td className="px-4 py-2 text-right">{d.apollo_credits}</td>
                        <td className="px-4 py-2 text-right font-medium text-slate-900">{usd(d.total_cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-4 py-2 text-[11px] text-slate-400">
                  All-time: {usd(costs.allTime.total_cost_usd)} across {costs.allTime.runs} runs ·
                  $ figures are estimates from metered credits/tokens at plan rates.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Controls */}
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <select
            value={date ?? ""}
            onChange={(e) => {
              setDate(e.target.value);
              load(e.target.value, statusFilter);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm outline-none focus:border-brand"
          >
            {dates.length === 0 && <option value="">no queue yet</option>}
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setStatusFilter("")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${statusFilter === "" ? "bg-brand text-white" : "bg-white text-slate-500 border border-slate-200"}`}
            >
              All {total ? `· ${total}` : ""}
            </button>
            {STATUSES.map((s) =>
              counts[s] ? (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s === statusFilter ? "" : s)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${statusFilter === s ? "bg-brand text-white" : "bg-white text-slate-500 border border-slate-200"}`}
                >
                  {s} · {counts[s]}
                </button>
              ) : null,
            )}
          </div>
        </div>

        {rows.length === 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
            No rows for this day. The research agent writes here each morning.
          </div>
        )}

        <div className="space-y-3">
          {rows.map((r0) => {
            const r = merged(r0);
            const open = openId === r.id;
            const conf = CONF_META[r.confidence ?? ""] ?? CONF_META.Low;
            const dirty = !!edits[r.id];
            const proof = hasProofToken(r);
            return (
              <div
                key={r.id}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:border-slate-300"
              >
                {/* Row header */}
                <button
                  onClick={() => setOpenId(open ? null : r.id)}
                  className="flex w-full items-center gap-3 px-5 py-4 text-left"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${conf.dot}`} title={r.confidence ?? ""} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-slate-900">
                        {r.first_name} {r.last_name}
                      </span>
                      <span className="truncate text-sm text-slate-500">{r.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                      <span className="font-semibold text-slate-700">{r.company}</span>
                      <span className="text-slate-300">·</span>
                      <span className="truncate">{r.trigger_type}</span>
                      {proof && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] text-amber-700">
                          PROOF token
                        </span>
                      )}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${STATUS_META[r.status] ?? ""}`}>
                    {r.status}
                  </span>
                </button>

                {open && (
                  <div className="border-t border-slate-100 px-5 py-4">
                    {/* GATE 1 — the trigger + source */}
                    <div className="mb-4 rounded-xl bg-slate-50 p-4">
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                        Gate 1 · verify the trigger
                      </p>
                      <p className="mt-1.5 text-sm text-slate-700">{r.trigger_detail}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                        {r.source_url ? (
                          <a
                            href={r.source_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand"
                          >
                            open source ↗
                          </a>
                        ) : (
                          <span className="text-red-600">no source URL — verify manually</span>
                        )}
                        <span>{r.bucket}</span>
                        <span>· {r.pillar}</span>
                        <span>· proof: {r.proof_point}</span>
                        {r.detected_stack && <span>· {r.detected_stack}</span>}
                        {r.verified_email && (
                          <span className="font-mono text-slate-600">{r.verified_email}</span>
                        )}
                      </div>
                    </div>

                    {/* Research provenance — why this row exists */}
                    <div className="mb-4 rounded-xl border border-brand/15 bg-brand/5 p-4">
                      <div className="flex items-center justify-between">
                        <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-brand">
                          Research
                        </p>
                        <div className="flex items-center gap-3 font-mono text-[11px] text-slate-600">
                          {r.size && <span>{r.size} employees</span>}
                          {r.researched_at && <span>· {r.researched_at.replace("T", " ")}</span>}
                        </div>
                      </div>
                      {r.fit_reason && (
                        <p className="mt-2 text-sm leading-relaxed text-slate-800">
                          <span className="font-semibold text-slate-900">Why this fits: </span>
                          {r.fit_reason}
                        </p>
                      )}
                      {r.research_trail && (
                        <p className="mt-2 text-xs leading-relaxed text-slate-600">
                          <span className="font-semibold text-slate-700">How we got here: </span>
                          {r.research_trail}
                        </p>
                      )}
                    </div>

                    {proof && (
                      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        ⚠ This draft still contains a <span className="font-mono">[PROOF: …]</span> token.
                        Replace it with an approved reference (or delete the sentence) before sending —
                        never send an email containing a token.
                      </div>
                    )}

                    {/* GATE 2 — the drafts, editable */}
                    <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                      Gate 2 · read &amp; edit the sequence
                    </p>
                    <div className="space-y-3">
                      {DRAFT_FIELDS.map((f) => (
                        <div key={f.key}>
                          <label className="text-xs font-medium text-slate-500">{f.label}</label>
                          <textarea
                            value={(r[f.key] as string) ?? ""}
                            onChange={(e) => setField(r.id, f.key, e.target.value)}
                            rows={f.key === "subject" ? 1 : 3}
                            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand/30"
                          />
                        </div>
                      ))}
                      <div>
                        <label className="text-xs font-medium text-slate-500">Rep notes</label>
                        <textarea
                          value={(r.rep_notes as string) ?? ""}
                          onChange={(e) => setField(r.id, "rep_notes", e.target.value)}
                          rows={2}
                          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand/30"
                        />
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <select
                        value={r.status}
                        onChange={(e) => setField(r.id, "status", e.target.value)}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand"
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => save(r0, (r.status as string) || undefined)}
                        disabled={saving === r.id}
                        className="rounded-lg bg-gradient-to-r from-brand to-brand-light px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-dark hover:to-brand disabled:opacity-40"
                      >
                        {saving === r.id ? "Saving…" : dirty ? "Save changes" : "Save"}
                      </button>
                      <button
                        onClick={() => copySequence(r0)}
                        className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
                      >
                        {copied === r.id ? "Copied ✓" : "Copy for Smartlead"}
                      </button>
                      <button
                        onClick={() => save(r0, "Sent")}
                        className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 shadow-sm transition hover:bg-emerald-100"
                      >
                        Mark sent
                      </button>
                      <button
                        onClick={() => save(r0, "Rejected")}
                        className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-600 shadow-sm transition hover:bg-red-100"
                      >
                        Reject
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
