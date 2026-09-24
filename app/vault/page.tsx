"use client";

import { useCallback, useEffect, useState } from "react";

// Apollo data — the Contact Vault. Every person Vitosha has paid Apollo for,
// searchable and exportable without going back to Apollo (or paying again).

type Row = {
  id: number;
  email: string | null;
  email_status: string | null;
  unsubscribed: boolean;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  phone: string | null;
  linkedin_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  company: string | null;
  domain: string | null;
  industry: string | null;
  employees: number | null;
  first_source: string | null;
  first_campaign: string | null;
  first_seen: string | null;
  apollo_source: string | null;
};

type Stats = {
  totals: {
    total: number; with_email: number; verified: number; with_phone: number; companies: number; unsubscribed: number;
  } | null;
  by_source: { source: string; campaign: string; n: number; credits_est: string | number; first_at: string | null; last_at: string | null }[];
  by_country: { country: string; n: number }[];
};

const EMPTY = { q: "", title: "", company: "", domain: "", country: "", state: "", source: "", campaign: "", email_status: "", has_phone: false, has_email: false };
type Filters = typeof EMPTY;
const PAGE = 50;

function n(v: number | string | null | undefined) {
  return v == null ? "–" : Number(v).toLocaleString("en-US");
}
function day(v: string | null) {
  return v ? v.slice(0, 10) : "";
}
const SOURCE_LABEL: Record<string, string> = { apollo: "Apollo (saved)", campaign: "Campaign pull", agent: "Research agent" };

export default function VaultPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const qs = useCallback((f: Filters, off: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
      if (typeof v === "boolean") { if (v) p.set(k, "1"); } else if (v.trim()) p.set(k, v.trim());
    }
    p.set("limit", String(PAGE));
    p.set("offset", String(off));
    return p.toString();
  }, []);

  const load = useCallback(async (f: Filters, off: number) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/vault?${qs(f, off)}`);
      const j = await r.json();
      if (r.status === 503 && j.configured === false) { setConfigured(false); return; }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setConfigured(true);
      setRows(j.rows);
      setTotal(j.total);
      setOffset(off);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [qs]);

  useEffect(() => {
    load(EMPTY, 0);
    fetch("/api/vault?stats=1").then(async (r) => { if (r.ok) setStats(await r.json()); }).catch(() => {});
  }, [load]);

  const apply = () => { setApplied(filters); load(filters, 0); };
  const reset = () => { setFilters(EMPTY); setApplied(EMPTY); load(EMPTY, 0); };
  const set = (k: keyof Filters, v: string | boolean) => setFilters((f) => ({ ...f, [k]: v }));

  const syncAgents = async () => {
    setSyncMsg("Syncing agent leads…");
    const r = await fetch("/api/vault/sync-agents", { method: "POST" });
    const j = await r.json();
    setSyncMsg(r.ok ? `Synced ${n(j.scanned)} agent leads (${n(j.contacts)} people).` : `Sync failed: ${j.error}`);
    load(applied, 0);
  };

  const exportHref = `/api/vault/export?${qs(applied, 0)}`;
  const t = stats?.totals;

  const input = (k: keyof Filters, placeholder: string, w = "w-40") => (
    <input
      value={filters[k] as string}
      onChange={(e) => set(k, e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && apply()}
      placeholder={placeholder}
      className={`${w} rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand focus:outline-none`}
    />
  );

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-7xl p-6">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              Apollo data
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              contact vault · every person we have paid for · search, slice, export
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={syncAgents}
              disabled={configured === false}
              title="Copy the research agents' leads (Outbound) into the vault"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900 disabled:opacity-50"
            >
              ⟳ Sync agent leads
            </button>
            <a
              href="/"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
            >
              ← Dashboard
            </a>
          </div>
        </header>

        {configured === false && (
          <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            The Contact Vault isn&apos;t connected yet. Add the Supabase project URL and service key on the{" "}
            <a href="/settings" className="font-semibold underline">Settings</a> page, after running{" "}
            <code className="rounded bg-amber-100 px-1">supabase/contact_vault.sql</code> in that project once.
          </div>
        )}

        {syncMsg && <div className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700">{syncMsg}</div>}

        {/* Totals */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["People", t?.total], ["With email", t?.with_email], ["Verified email", t?.verified],
            ["With phone", t?.with_phone], ["Companies", t?.companies], ["Unsubscribed", t?.unsubscribed],
          ].map(([label, v]) => (
            <div key={label as string} className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label as string}</div>
              <div className="mt-1 text-xl font-bold text-slate-900">{n(v as number | null | undefined)}</div>
            </div>
          ))}
        </div>

        {/* Where it came from */}
        {stats && stats.by_source.length > 0 && (
          <div className="mb-4">
            <button
              onClick={() => setShowSources((v) => !v)}
              className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm transition hover:border-slate-300"
            >
              <span className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">Where it came from</span>
                {["apollo", "campaign", "agent"].map((s) => {
                  const k = stats.by_source.filter((r) => r.source === s).reduce((a, r) => a + r.n, 0);
                  return k ? <span key={s}>{SOURCE_LABEL[s]} <b className="text-slate-900">{n(k)}</b></span> : null;
                })}
                <span className="hidden sm:inline text-slate-400">
                  ≈ {n(stats.by_source.reduce((a, r) => a + Number(r.credits_est || 0), 0))} Apollo credits (estimate: 1 per revealed email)
                </span>
              </span>
              <span className="text-[11px] font-medium text-brand">{showSources ? "collapse ▴" : "details ▾"}</span>
            </button>
            {showSources && (
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm lg:col-span-2">
                  <table className="w-full text-xs">
                    <thead className="text-left font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      <tr><th className="py-1">Source</th><th>Campaign / segment</th><th className="text-right">People</th><th className="text-right">Credits ≈</th><th className="text-right">First</th><th className="text-right">Last</th></tr>
                    </thead>
                    <tbody>
                      {stats.by_source.map((r, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="py-1">{SOURCE_LABEL[r.source] ?? r.source}</td>
                          <td className="text-slate-600">{r.campaign || "—"}</td>
                          <td className="text-right font-semibold">{n(r.n)}</td>
                          <td className="text-right">{n(r.credits_est)}</td>
                          <td className="text-right text-slate-500">{day(r.first_at)}</td>
                          <td className="text-right text-slate-500">{day(r.last_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">By country</div>
                  {stats.by_country.map((c) => (
                    <div key={c.country} className="flex justify-between border-t border-slate-100 py-1 text-xs">
                      <button className="text-left text-slate-700 hover:text-brand" onClick={() => { const f = { ...EMPTY, country: c.country }; setFilters(f); setApplied(f); load(f, 0); }}>
                        {c.country}
                      </button>
                      <span className="font-semibold">{n(c.n)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="mb-4 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            {input("q", "Name, email or company", "w-56")}
            {input("title", "Title contains…")}
            {input("company", "Company contains…")}
            {input("domain", "Domain")}
            {input("country", "Country (exact)", "w-36")}
            {input("state", "State (exact)", "w-32")}
            <select value={filters.source} onChange={(e) => set("source", e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700">
              <option value="">Any source</option>
              <option value="apollo">Apollo (saved)</option>
              <option value="campaign">Campaign pull</option>
              <option value="agent">Research agent</option>
            </select>
            {input("campaign", "Campaign / segment", "w-40")}
            <select value={filters.email_status} onChange={(e) => set("email_status", e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700">
              <option value="">Any email status</option>
              <option value="verified">Verified</option>
              <option value="unverified">Unverified</option>
              <option value="unavailable">Unavailable</option>
            </select>
            <label className="flex items-center gap-1 text-sm text-slate-600"><input type="checkbox" checked={filters.has_email} onChange={(e) => set("has_email", e.target.checked)} /> has email</label>
            <label className="flex items-center gap-1 text-sm text-slate-600"><input type="checkbox" checked={filters.has_phone} onChange={(e) => set("has_phone", e.target.checked)} /> has phone</label>
            <button onClick={apply} className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark">Search</button>
            <button onClick={reset} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400">Reset</button>
            <a href={exportHref} className="ml-auto rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-600 shadow-sm hover:border-slate-400 hover:text-slate-900" title="Download the current filter as CSV (up to 50,000 rows)">
              ⤓ Export CSV{total != null ? ` (${n(Math.min(total, 50000))})` : ""}
            </a>
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

        {/* Results */}
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left font-mono text-[10px] uppercase tracking-widest text-slate-500">
              <tr>
                <th className="px-3 py-2">Name</th><th className="px-3 py-2">Title</th><th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Email</th><th className="px-3 py-2">Phone</th><th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Source</th><th className="px-3 py-2">Since</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-1.5 font-medium text-slate-900">
                    {r.linkedin_url ? <a href={r.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-brand">{r.first_name} {r.last_name}</a> : <>{r.first_name} {r.last_name}</>}
                  </td>
                  <td className="px-3 py-1.5 text-slate-700">{r.title}</td>
                  <td className="px-3 py-1.5 text-slate-700">{r.company}{r.domain ? <span className="ml-1 text-xs text-slate-400">{r.domain}</span> : null}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">
                    {r.email ? (
                      <span className={r.unsubscribed ? "text-red-500 line-through" : r.email_status === "verified" ? "text-emerald-700" : "text-slate-600"} title={r.unsubscribed ? "unsubscribed" : r.email_status ?? ""}>{r.email}</span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-600">{r.phone ?? ""}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-600">{[r.city, r.state, r.country].filter(Boolean).join(", ")}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-600">{SOURCE_LABEL[r.first_source ?? ""] ?? r.first_source}{r.first_campaign ? <span className="block text-slate-400">{r.first_campaign}</span> : null}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-500">{day(r.first_seen)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && configured && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-slate-400">No contacts match.</td></tr>
              )}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
            <span>{loading ? "Loading…" : total != null ? `${n(offset + 1)}–${n(Math.min(offset + PAGE, total))} of ${n(total)}` : ""}</span>
            <span className="flex gap-2">
              <button disabled={offset === 0 || loading} onClick={() => load(applied, Math.max(0, offset - PAGE))} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">‹ Prev</button>
              <button disabled={loading || (total != null && offset + PAGE >= total)} onClick={() => load(applied, offset + PAGE)} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">Next ›</button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
