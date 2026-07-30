"use client";

import { useEffect, useMemo, useState } from "react";

// SEO watchdog widget on the Outbound landing screen. Data comes from
// /api/seo, filled daily by the instrumentation job (rankings weekly via
// Serper, competitor sitemaps + Search Console daily). "Check now" forces a
// full run — costs one Serper search per keyword.

type Ranking = {
  keyword: string;
  domain: string;
  position: number | null;
  url: string | null;
  delta: number | null;
};

type NewPage = { url: string; domain: string; first_seen: string };

type GscDay = {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  top_queries: string | null;
};

type SeoData = {
  config: {
    site: string;
    keywords: string[];
    competitors: string[];
    serper: boolean;
    gscSite: string;
    gscReady: boolean;
  };
  checkedAt: string | null;
  previousAt: string | null;
  rankings: Ranking[];
  newPages: NewPage[];
  gsc: GscDay[];
};

function fmtDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.length > 1 ? u.pathname : "/";
  } catch {
    return url;
  }
}

// Position pill: green top-10, amber top-30, slate top-100, muted otherwise.
function RankPill({ position }: { position: number | null }) {
  if (position == null)
    return (
      <span className="inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-400">
        &gt;100
      </span>
    );
  const cls =
    position <= 10
      ? "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200"
      : position <= 30
        ? "bg-amber-100 text-amber-700 ring-1 ring-amber-200"
        : "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}>#{position}</span>;
}

function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <div className="flex-1 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <p
        className={`mt-1 text-xl font-bold ${tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : "text-slate-900"}`}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p> : null}
    </div>
  );
}

// Tiny bar sparkline for GSC daily clicks — pure SVG, no library.
function Sparkline({ days }: { days: GscDay[] }) {
  if (days.length < 2) return null;
  const max = Math.max(1, ...days.map((d) => d.clicks));
  const w = 6, gap = 2;
  const width = days.length * (w + gap);
  return (
    <svg viewBox={`0 0 ${width} 36`} className="mt-2 h-9 w-full" preserveAspectRatio="none" aria-hidden>
      {days.map((d, i) => {
        const h = Math.max(1.5, (d.clicks / max) * 34);
        return (
          <rect
            key={d.date}
            x={i * (w + gap)}
            y={36 - h}
            width={w}
            height={h}
            rx={1.5}
            className={d.clicks > 0 ? "fill-brand/70" : "fill-slate-200"}
          />
        );
      })}
    </svg>
  );
}

export default function SeoWidget() {
  const [data, setData] = useState<SeoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);

  const load = () =>
    fetch("/api/seo")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  const runNow = async () => {
    setRunning(true);
    setRunNote(null);
    try {
      const res = await fetch("/api/seo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const d = await res.json();
      setRunNote(d?.report ? `${d.report.rankings} · ${d.report.pages} · ${d.report.gsc}` : "run finished");
      await load();
    } catch {
      setRunNote("run failed — see server logs");
    } finally {
      setRunning(false);
    }
  };

  // Our site's rows, in the configured keyword order.
  const ours = useMemo(() => {
    if (!data) return [];
    const rows = data.rankings.filter((r) => r.domain === data.config.site);
    const order = new Map(data.config.keywords.map((k, i) => [k, i] as const));
    return rows.sort((a, b) => (order.get(a.keyword) ?? 99) - (order.get(b.keyword) ?? 99));
  }, [data]);

  // Best competitor position per keyword, for the "who's winning" column.
  const bestRival = useMemo(() => {
    const m = new Map<string, Ranking>();
    for (const r of data?.rankings ?? []) {
      if (!data || r.domain === data.config.site || r.position == null) continue;
      const cur = m.get(r.keyword);
      if (!cur || (cur.position ?? 999) > r.position) m.set(r.keyword, r);
    }
    return m;
  }, [data]);

  const stats = useMemo(() => {
    const ranked = ours.filter((r) => r.position != null);
    const top10 = ranked.filter((r) => (r.position as number) <= 10).length;
    const up = ours.filter((r) => (r.delta ?? 0) > 0).length;
    const down = ours.filter((r) => (r.delta ?? 0) < 0).length;
    return { ranked: ranked.length, top10, up, down };
  }, [ours]);

  const gscTotals = useMemo(() => {
    const days = data?.gsc ?? [];
    const half = Math.floor(days.length / 2);
    const clicks = (list: GscDay[]) => list.reduce((a, d) => a + (d.clicks || 0), 0);
    return {
      clicks: clicks(days),
      impressions: days.reduce((a, d) => a + (d.impressions || 0), 0),
      recent: clicks(days.slice(half)),
      earlier: clicks(days.slice(0, half)),
    };
  }, [data]);

  const topQueries = useMemo(() => {
    const raw = [...(data?.gsc ?? [])].reverse().find((d) => d.top_queries)?.top_queries;
    if (!raw) return [];
    try {
      return JSON.parse(raw) as { query: string; clicks: number; impressions: number; position: number }[];
    } catch {
      return [];
    }
  }, [data]);

  if (loading) {
    return (
      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="py-6 text-center text-sm text-slate-400">Loading SEO watchdog…</p>
      </div>
    );
  }
  if (!data) return null;

  const { config } = data;
  const configured = config.serper && config.site && config.keywords.length > 0;

  return (
    <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <span aria-hidden>🔍</span> SEO watchdog
            {config.site ? (
              <a
                href={`https://${config.site}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-medium text-slate-500 hover:text-brand"
              >
                {config.site}
              </a>
            ) : null}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {data.checkedAt
              ? `Google rankings checked ${fmtDay(data.checkedAt)}${data.previousAt ? ` · movement vs ${fmtDay(data.previousAt)}` : " · first baseline"}`
              : "No ranking check has run yet"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {runNote ? <span className="max-w-xs truncate text-[11px] text-slate-400">{runNote}</span> : null}
          <button
            onClick={runNow}
            disabled={running || !configured}
            className="rounded-lg bg-gradient-to-r from-brand to-brand-light px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:from-brand-dark hover:to-brand disabled:opacity-40"
          >
            {running ? "Checking…" : "Check now"}
          </button>
        </div>
      </div>

      {!configured ? (
        <p className="rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
          Setup needed in <a href="/settings" className="font-semibold underline">Settings</a>:
          {!config.serper ? " Serper API key." : ""}
          {!config.site ? " Website address." : ""}
          {config.keywords.length === 0 ? " Keywords to track." : ""}
        </p>
      ) : null}

      {/* Scoreboard */}
      {ours.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-3">
          <StatCard
            label="Ranking"
            value={`${stats.ranked}/${ours.length}`}
            hint="keywords in Google top 100"
            tone={stats.ranked === 0 ? "bad" : undefined}
          />
          <StatCard
            label="Top 10"
            value={`${stats.top10}`}
            hint="first-page keywords"
            tone={stats.top10 > 0 ? "good" : undefined}
          />
          <StatCard
            label="Moved up"
            value={`${stats.up}`}
            hint="since previous check"
            tone={stats.up > 0 ? "good" : undefined}
          />
          <StatCard
            label="Moved down"
            value={`${stats.down}`}
            hint="since previous check"
            tone={stats.down > 0 ? "bad" : undefined}
          />
        </div>
      ) : null}

      {/* Rankings table */}
      {ours.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 font-mono text-[10px] uppercase tracking-widest text-slate-400">
                <th className="px-3 py-2">Keyword</th>
                <th className="px-3 py-2">Our rank</th>
                <th className="px-3 py-2">Change</th>
                <th className="px-3 py-2">Best competitor</th>
              </tr>
            </thead>
            <tbody>
              {ours.map((r) => {
                const rival = bestRival.get(r.keyword);
                return (
                  <tr key={r.keyword} className="border-b border-slate-100 transition last:border-0 hover:bg-slate-50/60">
                    <td className="px-3 py-2.5">
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noreferrer" className="font-medium text-slate-800 hover:text-brand hover:underline">
                          {r.keyword}
                        </a>
                      ) : (
                        <span className="text-slate-700">{r.keyword}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <RankPill position={r.position} />
                    </td>
                    <td className="px-3 py-2.5">
                      {r.delta == null || r.delta === 0 ? (
                        <span className="text-slate-300">—</span>
                      ) : r.delta > 0 ? (
                        <span className="text-xs font-bold text-emerald-600">▲ {r.delta}</span>
                      ) : (
                        <span className="text-xs font-bold text-red-600">▼ {Math.abs(r.delta)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">
                      {rival ? (
                        <span>
                          {rival.domain} <RankPill position={rival.position} />
                        </span>
                      ) : (
                        <span className="text-slate-300">none in top 100</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : configured ? (
        <p className="py-4 text-center text-xs text-slate-400">First ranking check runs automatically — or hit “Check now”.</p>
      ) : null}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {/* Search Console */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Google Search Console · 28 days
            </p>
            {config.gscReady && gscTotals.earlier > 0 ? (
              <span className={`text-xs font-bold ${gscTotals.recent >= gscTotals.earlier ? "text-emerald-600" : "text-red-600"}`}>
                {gscTotals.recent >= gscTotals.earlier ? "▲ trending up" : "▼ trending down"}
              </span>
            ) : null}
          </div>
          {config.gscReady ? (
            <>
              <div className="mt-2 flex items-baseline gap-3">
                <p className="text-2xl font-bold text-slate-900">{gscTotals.clicks}</p>
                <p className="text-xs text-slate-500">clicks from Google</p>
                <p className="text-xs text-slate-400">{gscTotals.impressions.toLocaleString()} impressions</p>
              </div>
              <Sparkline days={data.gsc} />
              {topQueries.length > 0 ? (
                <ul className="mt-3 space-y-1.5 text-xs text-slate-600">
                  {topQueries.slice(0, 5).map((q) => (
                    <li key={q.query} className="flex items-center justify-between gap-2">
                      <span className="truncate">{q.query}</span>
                      <span className="shrink-0 font-medium text-slate-400">
                        {q.clicks} clicks · #{q.position}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <div className="mt-2">
              <p className="text-sm font-semibold text-slate-600">Not connected yet</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                One-time step: enable the Search Console API on the Google Cloud project of the existing service
                account, then add that account&apos;s email as a user on the site&apos;s Search Console property.
                Free data, straight from Google.
              </p>
            </div>
          )}
        </div>

        {/* Competitor new pages */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              New competitor pages · 14 days
            </p>
            {config.competitors.length > 0 ? (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                watching {config.competitors.length}
              </span>
            ) : null}
          </div>
          {config.competitors.length === 0 ? (
            <div className="mt-2">
              <p className="text-sm font-semibold text-slate-600">No competitors yet</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                Add rival Microsoft partners&apos; websites in{" "}
                <a href="/settings" className="font-semibold text-brand underline">Settings</a> and every page they
                publish shows up here the next day.
              </p>
            </div>
          ) : data.newPages.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">
              Quiet — nothing new from {config.competitors.join(", ")}.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-xs">
              {data.newPages.slice(0, 8).map((p) => (
                <li key={p.url} className="flex items-center justify-between gap-2">
                  <a href={p.url} target="_blank" rel="noreferrer" className="truncate text-brand hover:underline">
                    <span className="font-medium">{p.domain}</span>
                    <span className="text-slate-500">{pathOf(p.url)}</span>
                  </a>
                  <span className="shrink-0 text-slate-400">{fmtDay(p.first_seen)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
