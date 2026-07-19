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
  market: string | null;
};

const MARKET_LABELS: Record<string, string> = { us: "US", gcc: "GCC", healthcare: "Healthcare" };

// Per-lead market badge colors — GCC stands out, US stays quiet.
const MARKET_BADGE: Record<string, string> = {
  us: "bg-slate-100 text-slate-500 ring-1 ring-slate-200",
  gcc: "bg-teal-100 text-teal-700 ring-1 ring-teal-300",
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
  brightdata_records: number;
  brightdata_cost_usd: number;
  total_cost_usd: number;
};

type MarketAgg = { market: string; runs: number; total_cost_usd: number };

type Costs = {
  today: CostAgg;
  week: CostAgg;
  month: CostAgg;
  allTime: CostAgg;
  markets?: { today: MarketAgg[]; week: MarketAgg[]; month: MarketAgg[]; allTime: MarketAgg[] };
  daily: { run_date: string; apollo_credits: number; total_cost_usd: number; runs: number }[];
};

// Which agent spent it: us/gcc = Vitosha, healthcare = Hanover Medzone agent.
const marketLabel = (m: string) => MARKET_LABELS[m] ?? m;

const usd = (n: number) => `$${(n ?? 0).toFixed(2)}`;
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n ?? 0}`;

function CostCard({ label, agg, markets }: { label: string; agg: CostAgg; markets?: MarketAgg[] }) {
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
        {(agg.brightdata_records ?? 0) > 0 && (
          <div className="flex justify-between">
            <span>LinkedIn · {compact(agg.brightdata_records)} rec</span>
            <span className="font-medium text-slate-800">{usd(agg.brightdata_cost_usd)}</span>
          </div>
        )}
      </div>
      {markets && markets.length > 1 && (
        <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          {markets.map((m, i) => (
            <span key={m.market}>
              {i > 0 && <span className="text-slate-300"> · </span>}
              {marketLabel(m.market)} <b className="text-slate-700">{usd(m.total_cost_usd)}</b>
            </span>
          ))}
        </div>
      )}
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

// "2026-07-16" → "Thu, Jul 16" for the day navigator (ISO stays in the value).
function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// One scope in the export menu: a label + hint, with .xlsx and .csv download links.
function ExportGroup({
  label,
  hint,
  xlsx,
  csv,
  onPick,
  last,
}: {
  label: string;
  hint: string;
  xlsx: string;
  csv: string;
  onPick: () => void;
  last?: boolean;
}) {
  return (
    <div className={last ? "" : "border-b border-slate-100"}>
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-xs font-semibold text-slate-700">{label}</span>
        <span className="font-mono text-[10px] text-slate-400">{hint}</span>
      </div>
      <div className="flex gap-1.5 px-3 pb-2.5 pt-1.5">
        <a
          href={xlsx}
          onClick={onPick}
          className="flex-1 rounded-md bg-brand/10 px-2 py-1.5 text-center text-[11px] font-medium text-brand transition hover:bg-brand hover:text-white"
        >
          Excel .xlsx
        </a>
        <a
          href={csv}
          onClick={onPick}
          className="flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-center text-[11px] font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
        >
          CSV
        </a>
      </div>
    </div>
  );
}

export default function Outbound() {
  const [date, setDate] = useState<string | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [dateCounts, setDateCounts] = useState<Record<string, number>>({});
  const [showExport, setShowExport] = useState(false);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [trigFilters, setTrigFilters] = useState<string[]>([]);
  const [showTrigMenu, setShowTrigMenu] = useState(false);
  // What span of days the list shows: one day (default), a rolling window,
  // everything, or a custom from/to range.
  const [viewMode, setViewMode] = useState<"day" | "7d" | "30d" | "all" | "custom">("day");
  const [viewFrom, setViewFrom] = useState("");
  const [viewTo, setViewTo] = useState("");
  const [showRangeMenu, setShowRangeMenu] = useState(false);
  const [confFilters, setConfFilters] = useState<string[]>([]);
  const [noPocOnly, setNoPocOnly] = useState(false);
  const [marketFilter, setMarketFilter] = useState("");
  // Region front door: "" shows the two agent tiles; "us"/"gcc" enters that
  // agent's workspace. Mirrored in the URL (?market=) so it's bookmarkable.
  const [marketScope, setMarketScope] = useState("");
  const [scopeReady, setScopeReady] = useState(false);
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
  // Adjustable split: drag the divider between list and reading pane
  // (desktop only). Width persists per browser; double-click resets.
  const [paneW, setPaneW] = useState<number | null>(null);
  const leftColRef = useRef<HTMLDivElement>(null);
  const dragInfo = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    const saved = Number(localStorage.getItem("mp_outbound_panew"));
    if (saved >= 280 && saved <= 640) setPaneW(saved);
  }, []);

  const onDividerDown = useCallback((e: React.PointerEvent) => {
    const el = leftColRef.current;
    if (!el) return;
    dragInfo.current = { startX: e.clientX, startW: el.getBoundingClientRect().width };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent) => {
      if (!dragInfo.current) return;
      const w = Math.min(640, Math.max(280, dragInfo.current.startW + (ev.clientX - dragInfo.current.startX)));
      setPaneW(w);
    };
    const up = () => {
      dragInfo.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPaneW((w) => {
        if (w) localStorage.setItem("mp_outbound_panew", String(w));
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  }, []);

  const resetPane = useCallback(() => {
    setPaneW(null);
    localStorage.removeItem("mp_outbound_panew");
  }, []);

  const isoDaysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const load = useCallback(
    async (opts?: { date?: string | null; mode?: typeof viewMode; from?: string; to?: string }) => {
      const mode = opts?.mode ?? "day";
      const params = new URLSearchParams();
      if (mode === "day") {
        if (opts?.date) params.set("date", opts.date);
      } else if (mode === "7d") params.set("from", isoDaysAgo(6));
      else if (mode === "30d") params.set("from", isoDaysAgo(29));
      else if (mode === "all") params.set("all", "1");
      else if (mode === "custom") {
        let f = opts?.from ?? "";
        let t = opts?.to ?? "";
        if (f && t && f > t) [f, t] = [t, f];
        if (f) params.set("from", f);
        if (t) params.set("to", t);
      }
      const res = await fetch(`/api/outbound?${params}`);
      const data = await res.json();
      if (data.date) setDate(data.date);
      setDates(data.dates);
      setDateCounts(data.dateCounts ?? {});
      setRows(data.rows);
      setCounts(data.counts);
      setSelectedId((prev) =>
        prev && (data.rows as Row[]).some((r) => r.id === prev) ? prev : (data.rows[0]?.id ?? null),
      );
    },
    [],
  );

  // Switch the visible span and fetch it.
  const setSpan = useCallback(
    (mode: "day" | "7d" | "30d" | "all" | "custom", from = "", to = "") => {
      setViewMode(mode);
      setViewFrom(from);
      setViewTo(to);
      setShowRangeMenu(false);
      load(mode === "day" ? { date, mode } : { mode, from, to });
    },
    [date, load],
  );

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read the region from the URL on mount and on back/forward navigation.
  useEffect(() => {
    const read = () => setMarketScope(new URLSearchParams(window.location.search).get("market") || "");
    read();
    setScopeReady(true);
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  const pickMarket = useCallback((m: string) => {
    setMarketScope(m);
    const u = new URL(window.location.href);
    u.searchParams.set("market", m);
    window.history.pushState({}, "", u.toString());
  }, []);

  const exitToRegions = useCallback(() => {
    setMarketScope("");
    const u = new URL(window.location.href);
    u.searchParams.delete("market");
    window.history.pushState({}, "", u.toString());
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

  // Prev/next day navigation. `dates` is newest-first, so "older" = higher index.
  const dateIdx = date ? dates.indexOf(date) : -1;
  const olderDate = dateIdx >= 0 && dateIdx < dates.length - 1 ? dates[dateIdx + 1] : null;
  const newerDate = dateIdx > 0 ? dates[dateIdx - 1] : null;
  const goToDate = (d: string | null) => {
    if (!d) return;
    setDate(d);
    setViewMode("day");
    load({ date: d, mode: "day" });
  };

  // The current span, as export/query params (mirrors what's on screen).
  const spanParams = (p: URLSearchParams) => {
    if (viewMode === "day") {
      if (date) p.set("date", date);
    } else if (viewMode === "7d") p.set("from", isoDaysAgo(6));
    else if (viewMode === "30d") p.set("from", isoDaysAgo(29));
    else if (viewMode === "custom") {
      if (viewFrom) p.set("from", viewFrom);
      if (viewTo) p.set("to", viewTo);
    } // "all" = no bounds
  };

  // Build an /export URL that mirrors whatever the rep is currently looking at.
  const exportUrl = (scope: "view" | "day" | "all", fmt: "xlsx" | "csv") => {
    const p = new URLSearchParams();
    p.set("format", fmt);
    if (marketScope) p.set("market", marketScope); // stay inside the entered region
    if (scope !== "all") spanParams(p);
    if (scope === "view") {
      // Apply the live filters so "current view" downloads exactly what's on screen.
      if (statusFilters.length) p.set("status", statusFilters.join(","));
      if (trigFilters.length) p.set("trigger", trigFilters.join(","));
      if (confFilters.length) p.set("conf", confFilters.join(","));
      if (noPocOnly) p.set("nopoc", "1");
      if (q.trim()) p.set("q", q.trim());
    }
    return `/api/outbound/export?${p.toString()}`;
  };

  // Custom date range (either bound optional). Orders the two dates so the
  // rep can type them in any order.
  const rangeValid = !!(rangeFrom || rangeTo);
  const rangeUrl = (fmt: "xlsx" | "csv") => {
    const p = new URLSearchParams();
    p.set("format", fmt);
    if (marketScope) p.set("market", marketScope);
    let from = rangeFrom;
    let to = rangeTo;
    if (from && to && from > to) [from, to] = [to, from];
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return `/api/outbound/export?${p.toString()}`;
  };

  // Everything below the region door works on the entered region's rows only.
  const scopedRows = useMemo(
    () => (marketScope ? rows.filter((r) => (r.market || "us") === marketScope) : rows),
    [rows, marketScope],
  );

  // Trigger types present in today's batch (drives the filter dropdown).
  const trigTypes = useMemo(
    () => Array.from(new Set(scopedRows.map((r) => r.trigger_type).filter(Boolean))) as string[],
    [scopedRows],
  );

  // Markets present in the current view. Inside a region scope this is always
  // one, so the mixed-market chips/badges only appear in unscoped edge cases.
  const markets = useMemo(
    () => Array.from(new Set(scopedRows.map((r) => r.market || "us"))).sort(),
    [scopedRows],
  );

  const CONF_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

  // The list the rep actually sees: search + filters + sort, all instant.
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = scopedRows.filter((r) => {
      if (statusFilters.length && !statusFilters.includes(r.status)) return false;
      if (trigFilters.length && !trigFilters.includes(r.trigger_type ?? "")) return false;
      if (confFilters.length && !confFilters.includes(r.confidence ?? "Low")) return false;
      if (noPocOnly && (r.first_name || r.verified_email)) return false;
      if (marketFilter && (r.market || "us") !== marketFilter) return false;
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
  }, [scopedRows, q, statusFilters, trigFilters, confFilters, noPocOnly, marketFilter, sortBy]);

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

  // ---- Region front door: two agent tiles; click one to enter its workspace.
  if (scopeReady && !marketScope) {
    const count = (m: string) => rows.filter((r) => (r.market || "us") === m).length;
    const pending = (m: string) =>
      rows.filter((r) => (r.market || "us") === m && r.status === "Pending").length;
    const TILES = [
      {
        m: "us", flag: "🇺🇸", name: "US Agent",
        desc: "United States · researched nightly at 1 PM ET",
        accent: "hover:border-brand/50 hover:shadow-brand/10",
      },
      {
        m: "gcc", flag: "🌍", name: "GCC Agent",
        desc: "UAE · Saudi · Qatar · Kuwait · Bahrain · Oman · nightly at 7 AM GST",
        accent: "hover:border-teal-400/60 hover:shadow-teal-500/10",
      },
    ];
    return (
      <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
        <div className="mx-auto max-w-4xl p-6">
          <header className="mb-8 flex items-center justify-between">
            <div>
              <h1 className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-2xl font-bold tracking-tight text-transparent">
                Outbound
              </h1>
              <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
                pick a region to review its agent&apos;s leads
              </p>
            </div>
            <a
              href="/"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
            >
              ← Dashboard
            </a>
          </header>

          <div className="grid gap-5 sm:grid-cols-2">
            {TILES.map((t) => {
              const n = count(t.m);
              const p = pending(t.m);
              return (
                <button
                  key={t.m}
                  onClick={() => pickMarket(t.m)}
                  className={`group rounded-2xl border border-slate-200 bg-white p-7 text-left shadow-sm transition hover:shadow-lg ${t.accent}`}
                >
                  <div className="text-4xl">{t.flag}</div>
                  <h2 className="mt-3 text-xl font-bold text-slate-900">{t.name}</h2>
                  <p className="mt-1 text-xs text-slate-500">{t.desc}</p>
                  <div className="mt-5 flex items-center gap-2 text-sm">
                    {n > 0 ? (
                      <>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
                          {n} lead{n === 1 ? "" : "s"} {date ? `· ${fmtDay(date)}` : ""}
                        </span>
                        {p > 0 && (
                          <span className="rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-700">
                            {p} pending review
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-400">
                        no leads yet {t.m === "gcc" ? "· first run tonight" : ""}
                      </span>
                    )}
                    <span className="ml-auto font-medium text-brand opacity-0 transition group-hover:opacity-100">
                      open →
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <p className="mt-6 text-center text-xs text-slate-400">
            Two independent nightly agents publish here. Each region has its own leads, filters and exports.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-7xl p-6">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              Outbound
              <span className="ml-2 align-middle text-base font-semibold text-slate-500">
                · {marketScope === "gcc" ? "🌍 GCC Agent" : "🇺🇸 US Agent"}
              </span>
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              triggered accounts · researched &amp; drafted nightly · you verify &amp; send
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exitToRegions}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
            >
              ⇄ Regions
            </button>
            <a
              href="/"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
            >
              ← Dashboard
            </a>
          </div>
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
                  <CostCard label="Today" agg={costs.today} markets={costs.markets?.today} />
                  <CostCard label="Last 7 days" agg={costs.week} markets={costs.markets?.week} />
                  <CostCard label="Last 30 days" agg={costs.month} markets={costs.markets?.month} />
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
          {/* Span: one day (with ◂ ▸ navigation), rolling windows, all, or custom range */}
          <div className="flex items-center rounded-lg border border-slate-300 bg-white shadow-sm">
            {(
              [
                ["day", "Day"],
                ["7d", "7 days"],
                ["30d", "30 days"],
                ["all", "All"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setSpan(m)}
                className={`px-3 py-2 text-xs font-medium transition first:rounded-l-lg ${
                  viewMode === m ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
            <div className="relative">
              <button
                onClick={() => setShowRangeMenu((v) => !v)}
                className={`rounded-r-lg border-l border-slate-200 px-3 py-2 text-xs font-medium transition ${
                  viewMode === "custom" ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {viewMode === "custom" && (viewFrom || viewTo)
                  ? `${viewFrom || "…"} → ${viewTo || "…"}`
                  : "Range ▾"}
              </button>
              {showRangeMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowRangeMenu(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1.5 w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
                    <p className="mb-2 text-xs font-semibold text-slate-700">Custom date range</p>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="date"
                        value={viewFrom}
                        max={dates[0] || undefined}
                        onChange={(e) => setViewFrom(e.target.value)}
                        className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-1.5 text-[11px] text-slate-700 outline-none focus:border-brand"
                      />
                      <span className="text-[11px] text-slate-400">→</span>
                      <input
                        type="date"
                        value={viewTo}
                        max={dates[0] || undefined}
                        onChange={(e) => setViewTo(e.target.value)}
                        className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-1.5 text-[11px] text-slate-700 outline-none focus:border-brand"
                      />
                    </div>
                    <button
                      onClick={() => (viewFrom || viewTo) && setSpan("custom", viewFrom, viewTo)}
                      disabled={!viewFrom && !viewTo}
                      className="mt-2 w-full rounded-md bg-brand/10 px-2 py-1.5 text-xs font-medium text-brand transition hover:bg-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Show range
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Day navigator — only meaningful in single-day mode */}
          {viewMode === "day" && (
            <div className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white shadow-sm">
              <button
                onClick={() => goToDate(olderDate)}
                disabled={!olderDate}
                title={olderDate ? `Older day · ${olderDate}` : "No older day"}
                className="rounded-l-lg px-2.5 py-2 text-slate-500 transition hover:bg-slate-50 hover:text-brand disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
              >
                ◂
              </button>
              <div className="relative">
                <select
                  value={date ?? ""}
                  onChange={(e) => goToDate(e.target.value)}
                  className="cursor-pointer appearance-none bg-transparent px-2 py-2 text-center text-sm font-medium text-slate-800 outline-none"
                >
                  {dates.length === 0 && <option value="">no queue yet</option>}
                  {dates.map((d) => (
                    <option key={d} value={d}>
                      {fmtDay(d)} · {dateCounts[d] ?? 0} lead{(dateCounts[d] ?? 0) === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => goToDate(newerDate)}
                disabled={!newerDate}
                title={newerDate ? `Newer day · ${newerDate}` : "No newer day"}
                className="px-2.5 py-2 text-slate-500 transition hover:bg-slate-50 hover:text-brand disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
              >
                ▸
              </button>
              {dates.length > 1 && date !== dates[0] && (
                <button
                  onClick={() => goToDate(dates[0])}
                  title={`Jump to newest · ${dates[0]}`}
                  className="rounded-r-lg border-l border-slate-200 px-2.5 py-2 text-[11px] font-medium text-brand transition hover:bg-slate-50"
                >
                  latest
                </button>
              )}
            </div>
          )}

          {/* Export menu — flexible scope × format */}
          <div className="relative">
            <button
              onClick={() => setShowExport((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-brand hover:text-brand"
            >
              <span aria-hidden>⭳</span> Export
              <span className="text-[10px] text-slate-400">{showExport ? "▴" : "▾"}</span>
            </button>
            {showExport && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowExport(false)} />
                <div className="absolute left-0 top-full z-20 mt-1.5 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                  <ExportGroup
                    label={viewMode === "day" ? "This day" : "Current span"}
                    hint={
                      viewMode === "day"
                        ? date
                          ? `${fmtDay(date)} · ${dateCounts[date] ?? 0} leads`
                          : "current day"
                        : `${scopedRows.length} leads in view span`
                    }
                    xlsx={exportUrl("day", "xlsx")}
                    csv={exportUrl("day", "csv")}
                    onPick={() => setShowExport(false)}
                  />
                  <ExportGroup
                    label="Current view"
                    hint={`${visible.length} filtered lead${visible.length === 1 ? "" : "s"}`}
                    xlsx={exportUrl("view", "xlsx")}
                    csv={exportUrl("view", "csv")}
                    onPick={() => setShowExport(false)}
                  />
                  <ExportGroup
                    label="All days"
                    hint="every lead ever queued"
                    xlsx={exportUrl("all", "xlsx")}
                    csv={exportUrl("all", "csv")}
                    onPick={() => setShowExport(false)}
                  />

                  {/* Custom date range — leave a bound blank for open-ended */}
                  <div className="bg-slate-50/60 px-3 py-2.5">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-700">Date range</span>
                      <span className="font-mono text-[10px] text-slate-400">pick two dates</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="date"
                        value={rangeFrom}
                        max={dates[0] || undefined}
                        onChange={(e) => setRangeFrom(e.target.value)}
                        className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-700 outline-none focus:border-brand"
                      />
                      <span className="text-[11px] text-slate-400">→</span>
                      <input
                        type="date"
                        value={rangeTo}
                        max={dates[0] || undefined}
                        onChange={(e) => setRangeTo(e.target.value)}
                        className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-700 outline-none focus:border-brand"
                      />
                    </div>
                    <div className="mt-1.5 flex gap-1.5">
                      {rangeValid ? (
                        <>
                          <a
                            href={rangeUrl("xlsx")}
                            onClick={() => setShowExport(false)}
                            className="flex-1 rounded-md bg-brand/10 px-2 py-1.5 text-center text-[11px] font-medium text-brand transition hover:bg-brand hover:text-white"
                          >
                            Excel .xlsx
                          </a>
                          <a
                            href={rangeUrl("csv")}
                            onClick={() => setShowExport(false)}
                            className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-center text-[11px] font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
                          >
                            CSV
                          </a>
                        </>
                      ) : (
                        <span className="px-1 py-1 text-[10.5px] text-slate-400">
                          Set a start and/or end date to download a range.
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Status — multi-select: click several to combine (e.g. Pending + Verified) */}
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setStatusFilters([])}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${statusFilters.length === 0 ? "bg-brand text-white" : "bg-white text-slate-500 border border-slate-200"}`}
            >
              All {total ? `· ${total}` : ""}
            </button>
            {STATUSES.map((s) => {
              if (!counts[s]) return null;
              const on = statusFilters.includes(s);
              return (
                <button
                  key={s}
                  onClick={() =>
                    setStatusFilters((prev) => (on ? prev.filter((x) => x !== s) : [...prev, s]))
                  }
                  title={on ? `Remove ${s} from filter` : `Add ${s} to filter`}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${on ? "bg-brand text-white" : "bg-white text-slate-500 border border-slate-200"}`}
                >
                  {s} · {counts[s]}
                  {on && <span className="ml-1 text-[9px]">✓</span>}
                </button>
              );
            })}
          </div>
          <span className="ml-auto hidden text-[11px] text-slate-400 lg:inline">↑↓ to move between leads</span>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
            {viewMode === "day"
              ? "No rows for this day. The research agent writes here each morning."
              : "No rows in this span. Try a wider range or jump back to Day view."}
          </div>
        ) : (
          <div
            className="flex flex-col gap-4 lg:h-[calc(100vh-13rem)] lg:flex-row lg:gap-0"
            style={paneW ? ({ "--panew": `${paneW}px` } as React.CSSProperties) : undefined}
          >
            {/* ------- Left: search + filters + lead list ------- */}
            <div ref={leftColRef} className="flex shrink-0 flex-col lg:w-[var(--panew,360px)]">
              <div className="mb-3 space-y-2">
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search company, name, title…  ( / )"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-800 placeholder-slate-400 shadow-sm outline-none transition focus:border-brand focus:ring-1 focus:ring-brand/30"
                />
                <div className="flex gap-2">
                  {/* Triggers — multi-select popover (pick several together) */}
                  <div className="relative min-w-0 flex-1">
                    <button
                      onClick={() => setShowTrigMenu((v) => !v)}
                      className={`w-full rounded-lg border bg-white px-3 py-2 text-left text-xs shadow-sm outline-none transition ${
                        trigFilters.length
                          ? "border-brand/50 font-medium text-brand"
                          : "border-slate-200 text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      {trigFilters.length === 0
                        ? "All triggers"
                        : trigFilters.length === 1
                          ? trigFilters[0]
                          : `${trigFilters.length} triggers`}
                      <span className="float-right text-[10px] text-slate-400">▾</span>
                    </button>
                    {showTrigMenu && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowTrigMenu(false)} />
                        <div className="absolute left-0 top-full z-20 mt-1.5 w-full min-w-[220px] rounded-xl border border-slate-200 bg-white py-1.5 shadow-lg">
                          {trigTypes.map((t) => {
                            const on = trigFilters.includes(t);
                            return (
                              <button
                                key={t}
                                onClick={() =>
                                  setTrigFilters((prev) =>
                                    on ? prev.filter((x) => x !== t) : [...prev, t],
                                  )
                                }
                                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs text-slate-700 transition hover:bg-slate-50"
                              >
                                <span
                                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                                    on ? "border-brand bg-brand text-white" : "border-slate-300 bg-white"
                                  }`}
                                >
                                  {on ? "✓" : ""}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{t}</span>
                                <span className="text-[10px] text-slate-400">
                                  {scopedRows.filter((r) => r.trigger_type === t).length}
                                </span>
                              </button>
                            );
                          })}
                          {trigFilters.length > 0 && (
                            <button
                              onClick={() => setTrigFilters([])}
                              className="mt-1 w-full border-t border-slate-100 px-3.5 py-2 text-left text-[11px] font-medium text-brand hover:bg-slate-50"
                            >
                              Clear — show all triggers
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                    className="w-[118px] shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs text-slate-600 shadow-sm outline-none focus:border-brand"
                  >
                    <option value="confidence">Conf. first</option>
                    <option value="company">Company A–Z</option>
                    <option value="recent">Newest trigger</option>
                  </select>
                </div>
                {/* Confidence — multi-select chips (e.g. High + Medium together),
                    plus the no-contact toggle at the end of the row */}
                <div className="flex gap-2">
                  {(["High", "Medium", "Low"] as const).map((c) => {
                    const on = confFilters.includes(c);
                    return (
                      <button
                        key={c}
                        onClick={() =>
                          setConfFilters((prev) => (on ? prev.filter((x) => x !== c) : [...prev, c]))
                        }
                        title={on ? `Hide ${c} confidence` : `Include ${c} confidence`}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium shadow-sm transition ${
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
                  <button
                    onClick={() => setNoPocOnly((v) => !v)}
                    title="Only leads with no contact (manual sourcing)"
                    className={`shrink-0 rounded-lg border px-2.5 py-2 text-xs font-medium shadow-sm transition ${
                      noPocOnly ? "border-red-300 bg-red-50 text-red-600" : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                    }`}
                  >
                    no&nbsp;POC
                  </button>
                </div>

                {/* Market chips — only when this day mixes US + GCC rows */}
                {markets.length > 1 && (
                  <div className="flex gap-1.5">
                    {markets.map((m) => {
                      const on = marketFilter === m;
                      return (
                        <button
                          key={m}
                          onClick={() => setMarketFilter(on ? "" : m)}
                          title={on ? "Show all markets" : `Only ${MARKET_LABELS[m] ?? m.toUpperCase()} leads`}
                          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide shadow-sm transition ${
                            on
                              ? "border-brand/50 bg-brand/5 text-brand"
                              : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                          }`}
                        >
                          {MARKET_LABELS[m] ?? m.toUpperCase()}
                          {on && <span className="text-[9px]">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="px-0.5 text-[11px] text-slate-400">
                  {visible.length} of {scopedRows.length} lead{scopedRows.length === 1 ? "" : "s"}
                  {(q || trigFilters.length > 0 || confFilters.length > 0 || noPocOnly || statusFilters.length > 0 || marketFilter) && (
                    <button
                      onClick={() => {
                        setQ("");
                        setTrigFilters([]);
                        setConfFilters([]);
                        setNoPocOnly(false);
                        setStatusFilters([]);
                        setMarketFilter("");
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
                      {markets.length > 1 && (
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${MARKET_BADGE[r.market || "us"] ?? MARKET_BADGE.us}`}
                          title={`${MARKET_LABELS[r.market || "us"] ?? r.market} market lead`}
                        >
                          {MARKET_LABELS[r.market || "us"] ?? (r.market || "us").toUpperCase()}
                        </span>
                      )}
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
                      {viewMode !== "day" && (
                        <span className="ml-auto shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">
                          {fmtDay(r.queued_date)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
              </div>
            </div>

            {/* ------- Divider: drag to resize the split, double-click to reset ------- */}
            <div
              onPointerDown={onDividerDown}
              onDoubleClick={resetPane}
              title="Drag to resize · double-click to reset"
              className="group hidden w-4 shrink-0 cursor-col-resize items-stretch justify-center lg:flex"
            >
              <div className="w-1 rounded-full bg-slate-200 transition group-hover:bg-brand/50 group-active:bg-brand" />
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
                        {(markets.length > 1 || (sel.market && sel.market !== "us")) && (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${MARKET_BADGE[sel.market || "us"] ?? MARKET_BADGE.us}`}
                          >
                            {MARKET_LABELS[sel.market || "us"] ?? (sel.market || "us").toUpperCase()}
                          </span>
                        )}
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
