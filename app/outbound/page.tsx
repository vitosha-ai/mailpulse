"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  { key: "email_1", label: "Email 1", day: "Day 0" },
  { key: "followup_day_3", label: "Follow-up", day: "Day 3" },
  { key: "followup_day_8", label: "Follow-up", day: "Day 8" },
  { key: "breakup_day_15", label: "Breakup", day: "Day 15" },
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
  return (
    DRAFT_FIELDS.some((f) => (r[f.key] as string | null | undefined)?.includes("[PROOF:")) ||
    (r.subject ?? "").includes("[PROOF:")
  );
}

// Rows estimate so textareas read like text, not cramped form boxes.
function rowsFor(text: string | null | undefined, min = 2): number {
  const t = text ?? "";
  const byLength = Math.ceil(t.length / 78);
  const byLines = t.split("\n").length;
  return Math.min(12, Math.max(min, byLength, byLines));
}

export default function Outbound() {
  const [date, setDate] = useState<string | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [trigFilter, setTrigFilter] = useState("");
  const [confFilters, setConfFilters] = useState<string[]>([]);
  const [noPocOnly, setNoPocOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"confidence" | "company" | "recent">("confidence");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [edits, setEdits] = useState<Record<number, Partial<Row>>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [costs, setCosts] = useState<Costs | null>(null);
  const [showSpend, setShowSpend] = useState(false);
  const [showTrail, setShowTrail] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (d?: string | null) => {
    const params = new URLSearchParams();
    if (d) params.set("date", d);
    const res = await fetch(`/api/outbound?${params}`);
    const data = await res.json();
    setDate(data.date);
    setDates(data.dates);
    setRows(data.rows);
    setCounts(data.counts);
    setSelectedId((prev) =>
      prev && (data.rows as Row[]).some((r) => r.id === prev) ? prev : (data.rows[0]?.id ?? null),
    );
  }, []);

  useEffect(() => {
    load(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch("/api/outbound/costs")
      .then((r) => r.json())
      .then(setCosts)
      .catch(() => setCosts(null));
  }, []);

  const merged = useCallback((r: Row): Row => ({ ...r, ...edits[r.id] }), [edits]);

  const setField = (id: number, key: keyof Row, value: string) =>
    setEdits((e) => ({ ...e, [id]: { ...e[id], [key]: value } }));

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);

  // Trigger types present in today's batch (drives the filter dropdown).
  const trigTypes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.trigger_type).filter(Boolean))) as string[],
    [rows],
  );

  const CONF_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

  // The list the rep actually sees: search + filters + sort, all instant.
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (trigFilter && r.trigger_type !== trigFilter) return false;
      if (confFilters.length && !confFilters.includes(r.confidence ?? "Low")) return false;
      if (noPocOnly && (r.first_name || r.verified_email)) return false;
      if (needle) {
        const hay = `${r.company} ${r.first_name} ${r.last_name} ${r.title} ${r.verified_email}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    out.sort((a, b) => {
      if (sortBy === "company") return (a.company ?? "").localeCompare(b.company ?? "");
      if (sortBy === "recent") return (b.trigger_date ?? "").localeCompare(a.trigger_date ?? "");
      return (
        (CONF_ORDER[a.confidence ?? "Low"] ?? 3) - (CONF_ORDER[b.confidence ?? "Low"] ?? 3) ||
        (a.company ?? "").localeCompare(b.company ?? "")
      );
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, statusFilter, trigFilter, confFilters, noPocOnly, sortBy]);

  // Keep the selection inside the visible set as filters change.
  useEffect(() => {
    if (visible.length && !visible.some((r) => r.id === selectedId)) {
      setSelectedId(visible[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const selectRow = useCallback(
    (id: number) => {
      setSelectedId(id);
      setShowTrail(false);
      detailRef.current?.scrollTo({ top: 0 });
      // On stacked (mobile) layout, bring the detail pane into view.
      if (window.innerWidth < 1024) {
        setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      }
    },
    [],
  );

  // Keyboard review: ↑/↓ or j/k moves through the visible list; "/" jumps to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (!dir || visible.length === 0) return;
      e.preventDefault();
      const idx = visible.findIndex((r) => r.id === selectedId);
      const next = visible[Math.min(visible.length - 1, Math.max(0, (idx === -1 ? 0 : idx) + dir))];
      if (next) {
        selectRow(next.id);
        listRef.current
          ?.querySelector(`[data-row-id="${next.id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selectedId, selectRow]);

  const save = async (r: Row, status?: string) => {
    setSaving(r.id);
    const fields: Record<string, string> = {};
    for (const f of DRAFT_FIELDS) fields[f.key] = (merged(r)[f.key] as string) ?? "";
    fields.subject = (merged(r).subject as string) ?? "";
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
  const sel = selected ? merged(selected) : null;
  const selProof = sel ? hasProofToken(sel) : false;
  const selDirty = selected ? !!edits[selected.id] : false;
  const selConf = CONF_META[sel?.confidence ?? ""] ?? CONF_META.Low;

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-7xl p-6">
        <header className="mb-5 flex items-center justify-between">
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

        {/* Agent spend — one compact strip; expand for the full breakdown */}
        {costs && (
          <div className="mb-4">
            <button
              onClick={() => setShowSpend((v) => !v)}
              className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm transition hover:border-slate-300"
            >
              <span className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                  Agent spend
                </span>
                <span>
                  Today <b className="text-slate-900">{usd(costs.today.total_cost_usd)}</b>
                </span>
                <span>
                  7d <b className="text-slate-900">{usd(costs.week.total_cost_usd)}</b>
                </span>
                <span>
                  30d <b className="text-slate-900">{usd(costs.month.total_cost_usd)}</b>
                </span>
                <span className="hidden sm:inline text-slate-400">
                  {compact(costs.month.apollo_credits)} Apollo credits · {compact(costs.month.anthropic_tokens)} Claude tok (30d)
                </span>
              </span>
              <span className="text-[11px] font-medium text-brand">{showSpend ? "collapse ▴" : "details ▾"}</span>
            </button>
            {showSpend && (
              <div className="mt-3 space-y-3">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <CostCard label="Today" agg={costs.today} />
                  <CostCard label="Last 7 days" agg={costs.week} />
                  <CostCard label="Last 30 days" agg={costs.month} />
                </div>
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
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
              </div>
            )}
          </div>
        )}

        {/* Controls */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <select
            value={date ?? ""}
            onChange={(e) => {
              setDate(e.target.value);
              load(e.target.value);
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
          <span className="ml-auto hidden text-[11px] text-slate-400 lg:inline">↑↓ to move between leads</span>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
            No rows for this day. The research agent writes here each morning.
          </div>
        ) : (
          <div className="flex flex-col gap-4 lg:h-[calc(100vh-13rem)] lg:flex-row">
            {/* ------- Left: search + filters + lead list ------- */}
            <div className="flex shrink-0 flex-col lg:w-[330px]">
              <div className="mb-2 space-y-1.5">
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search company, name, title…  ( / )"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 shadow-sm outline-none transition focus:border-brand focus:ring-1 focus:ring-brand/30"
                />
                <div className="flex gap-1.5">
                  <select
                    value={trigFilter}
                    onChange={(e) => setTrigFilter(e.target.value)}
                    className={`min-w-0 flex-1 rounded-lg border bg-white px-2 py-1.5 text-[11px] shadow-sm outline-none focus:border-brand ${trigFilter ? "border-brand/50 text-brand font-medium" : "border-slate-200 text-slate-600"}`}
                  >
                    <option value="">All triggers</option>
                    {trigTypes.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                    className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-600 shadow-sm outline-none focus:border-brand"
                  >
                    <option value="confidence">Conf. first</option>
                    <option value="company">Company A–Z</option>
                    <option value="recent">Newest trigger</option>
                  </select>
                  <button
                    onClick={() => setNoPocOnly((v) => !v)}
                    title="Only leads with no contact (manual sourcing)"
                    className={`shrink-0 rounded-lg border px-2 py-1.5 text-[11px] font-medium shadow-sm transition ${
                      noPocOnly ? "border-red-300 bg-red-50 text-red-600" : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                    }`}
                  >
                    no&nbsp;POC
                  </button>
                </div>
                {/* Confidence — multi-select chips (e.g. High + Medium together) */}
                <div className="flex gap-1.5">
                  {(["High", "Medium", "Low"] as const).map((c) => {
                    const on = confFilters.includes(c);
                    return (
                      <button
                        key={c}
                        onClick={() =>
                          setConfFilters((prev) => (on ? prev.filter((x) => x !== c) : [...prev, c]))
                        }
                        title={on ? `Hide ${c} confidence` : `Include ${c} confidence`}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium shadow-sm transition ${
                          on
                            ? "border-brand/50 bg-brand/5 text-brand"
                            : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${CONF_META[c].dot}`} />
                        {c}
                        {on && <span className="text-[9px]">✓</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="px-0.5 text-[11px] text-slate-400">
                  {visible.length} of {rows.length} lead{rows.length === 1 ? "" : "s"}
                  {(q || trigFilter || confFilters.length > 0 || noPocOnly || statusFilter) && (
                    <button
                      onClick={() => {
                        setQ("");
                        setTrigFilter("");
                        setConfFilters([]);
                        setNoPocOnly(false);
                        setStatusFilter("");
                      }}
                      className="ml-2 font-medium text-brand hover:underline"
                    >
                      clear filters
                    </button>
                  )}
                </p>
              </div>
              <div ref={listRef} className="max-h-[34vh] flex-1 space-y-1.5 overflow-y-auto pr-1 lg:max-h-none">
              {visible.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-4 text-center text-xs text-slate-400">
                  No leads match these filters.
                </div>
              )}
              {visible.map((r0) => {
                const r = merged(r0);
                const conf = CONF_META[r.confidence ?? ""] ?? CONF_META.Low;
                const active = r.id === selectedId;
                const noPoc = !r.first_name && !r.verified_email;
                return (
                  <button
                    key={r.id}
                    data-row-id={r.id}
                    onClick={() => selectRow(r.id)}
                    className={`block w-full rounded-xl border px-3.5 py-2.5 text-left transition ${
                      active
                        ? "border-brand/60 bg-white shadow-md ring-1 ring-brand/25"
                        : "border-slate-200 bg-white/70 hover:border-slate-300 hover:bg-white"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${conf.dot}`} title={r.confidence ?? ""} />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                        {noPoc ? r.company : `${r.first_name} ${r.last_name ?? ""}`}
                      </span>
                      {edits[r.id] && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" title="unsaved edits" />}
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_META[r.status] ?? ""}`}>
                        {r.status}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-4 text-xs text-slate-500">
                      <span className="truncate">
                        {noPoc ? <span className="italic text-red-500">no contact — manual</span> : r.title}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-4 text-[11px] text-slate-400">
                      {!noPoc && <span className="truncate font-medium text-slate-600">{r.company}</span>}
                      <span className="truncate">· {r.trigger_type}</span>
                    </div>
                  </button>
                );
              })}
              </div>
            </div>

            {/* ------- Right: reading pane ------- */}
            <div
              ref={detailRef}
              className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-sm"
            >
              {!sel ? (
                <div className="p-10 text-center text-sm text-slate-400">Select a lead to review.</div>
              ) : (
                <div className="p-6">
                  {/* Lead header */}
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${selConf.dot}`} />
                        <h2 className="truncate text-lg font-bold text-slate-900">
                          {sel.first_name ? `${sel.first_name} ${sel.last_name ?? ""}` : sel.company}
                        </h2>
                        <span className={`text-xs font-semibold ${selConf.text}`}>{sel.confidence}</span>
                      </div>
                      <p className="mt-0.5 text-sm text-slate-600">
                        {sel.first_name ? (
                          <>
                            {sel.title} · <b className="text-slate-800">{sel.company}</b>
                          </>
                        ) : (
                          <span className="text-red-600">No verified contact found — source manually</span>
                        )}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                        {sel.verified_email && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{sel.verified_email}</span>
                        )}
                        {sel.linkedin && (
                          <a
                            href={sel.linkedin.startsWith("http") ? sel.linkedin : `https://${sel.linkedin}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-brand hover:underline"
                          >
                            LinkedIn ↗
                          </a>
                        )}
                        <span>{sel.bucket}</span>
                        <span>· {sel.pillar}</span>
                        {sel.detected_stack && <span>· {sel.detected_stack}</span>}
                        {sel.size && <span>· {sel.size} emp</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <select
                        value={sel.status}
                        onChange={(e) => setField(sel.id, "status", e.target.value)}
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-brand"
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => selected && save(selected, (sel.status as string) || undefined)}
                        disabled={saving === sel.id}
                        className="rounded-lg bg-gradient-to-r from-brand to-brand-light px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:from-brand-dark hover:to-brand disabled:opacity-40"
                      >
                        {saving === sel.id ? "Saving…" : selDirty ? "Save changes" : "Save"}
                      </button>
                      <button
                        onClick={() => selected && copySequence(selected)}
                        className="rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
                      >
                        {copied === sel.id ? "Copied ✓" : "Copy for Smartlead"}
                      </button>
                      <button
                        onClick={() => selected && save(selected, "Sent")}
                        className="rounded-lg border border-emerald-300 bg-emerald-50 px-3.5 py-1.5 text-xs font-medium text-emerald-700 shadow-sm transition hover:bg-emerald-100"
                      >
                        Mark sent
                      </button>
                      <button
                        onClick={() => selected && save(selected, "Rejected")}
                        className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-1.5 text-xs font-medium text-red-600 shadow-sm transition hover:bg-red-100"
                      >
                        Reject
                      </button>
                    </div>
                  </div>

                  {/* Trigger — the "why now" */}
                  <div className="mt-4 rounded-xl bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                        {sel.trigger_type} · {sel.trigger_date}
                      </p>
                      {sel.source_url ? (
                        <a
                          href={sel.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-semibold text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand"
                        >
                          verify source ↗
                        </a>
                      ) : (
                        <span className="text-xs font-medium text-red-600">no source URL — verify manually</span>
                      )}
                    </div>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-slate-800">{sel.trigger_detail}</p>
                    {sel.fit_reason && (
                      <p className="mt-2 border-t border-slate-200/70 pt-2 text-[13px] leading-relaxed text-slate-600">
                        {sel.fit_reason}
                      </p>
                    )}
                    <button
                      onClick={() => setShowTrail((v) => !v)}
                      className="mt-2 text-[11px] font-medium text-brand hover:underline"
                    >
                      {showTrail ? "hide research trail ▴" : "research trail ▾"}
                    </button>
                    {showTrail && sel.research_trail && (
                      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{sel.research_trail}</p>
                    )}
                  </div>

                  {selProof && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      ⚠ This draft still contains a <span className="font-mono">[PROOF: …]</span> token. Replace it with an
                      approved reference (or delete the sentence) before sending.
                    </div>
                  )}

                  {/* The sequence, styled as readable emails (click any text to edit) */}
                  {sel.email_1 ? (
                    <div className="mt-4 space-y-3">
                      <div className="flex items-baseline gap-2">
                        <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">Sequence</p>
                        <p className="text-[11px] text-slate-400">click any text to edit · Save when done</p>
                      </div>

                      {/* Subject */}
                      <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-400">Subject</span>
                        <input
                          value={sel.subject ?? ""}
                          onChange={(e) => setField(sel.id, "subject", e.target.value)}
                          className="w-full border-none bg-transparent text-sm font-medium text-slate-900 outline-none"
                        />
                      </div>

                      {DRAFT_FIELDS.map((f) => (
                        <div key={f.key} className="overflow-hidden rounded-xl border border-slate-200">
                          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-3.5 py-1.5">
                            <span className="text-xs font-semibold text-slate-700">{f.label}</span>
                            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{f.day}</span>
                          </div>
                          <textarea
                            value={(sel[f.key] as string) ?? ""}
                            onChange={(e) => setField(sel.id, f.key, e.target.value)}
                            rows={rowsFor(sel[f.key] as string)}
                            className="block w-full resize-none border-none bg-white px-3.5 py-2.5 text-[13.5px] leading-relaxed text-slate-800 outline-none transition focus:bg-blue-50/30"
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50/50 p-5 text-center text-sm text-slate-500">
                      No drafts yet for this lead{sel.first_name ? "" : " (no contact to write to)"} — it was queued
                      beyond the run&apos;s draft budget or has no verified contact.
                    </div>
                  )}

                  {/* Rep notes */}
                  <div className="mt-4">
                    <label className="text-xs font-medium text-slate-500">Rep notes</label>
                    <textarea
                      value={(sel.rep_notes as string) ?? ""}
                      onChange={(e) => setField(sel.id, "rep_notes", e.target.value)}
                      rows={rowsFor(sel.rep_notes, 2)}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand/30"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
