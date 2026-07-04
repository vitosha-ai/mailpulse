"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Sender = {
  email: string;
  domain: string;
  provider: string;
  instantly_status: number | null;
  warmup_status: number | null;
  warmup_score: number | null;
  daily_limit: number | null;
  bounce_rate: number | null;
  combined_score: number | null;
  health_status: string;
  spf_ok: number | null;
  dkim_ok: number | null;
  dmarc_ok: number | null;
  blocklists: string | null;
  google_verdict: string | null;
  microsoft_verdict: string | null;
  last_placement_test: string | null;
};

type Alert = {
  id: number;
  target: string;
  rule: string;
  severity: string;
  message: string;
  created_at: string;
};

const STATUS_DOT: Record<string, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
  unknown: "bg-zinc-300",
};

const PROVIDER_LABEL: Record<string, string> = {
  maildoso: "Maildoso",
  google: "Google",
  microsoft: "Microsoft",
  other: "Other",
};

function isBlocklisted(s: Sender): boolean {
  if (!s.blocklists) return false;
  try {
    return (JSON.parse(s.blocklists) as { listed: boolean }[]).some((b) => b.listed);
  } catch {
    return false;
  }
}

export default function Dashboard() {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (statusFilter) qs.set("status", statusFilter);
    if (providerFilter) qs.set("provider", providerFilter);
    if (search) qs.set("q", search);
    const [sRes, aRes] = await Promise.all([
      fetch(`/api/senders?${qs}`),
      fetch("/api/alerts"),
    ]);
    const sData = await sRes.json();
    const aData = await aRes.json();
    setSenders(sData.senders ?? []);
    setCounts(sData.counts ?? {});
    setAlerts(aData.alerts ?? []);
  }, [statusFilter, providerFilter, search]);

  useEffect(() => {
    load();
  }, [load]);

  const runSync = async () => {
    setBusy("Syncing with Instantly + Saleshandy + DNS — this can take a few minutes…");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setNotice(
        data.report
          ? `Sync done. ${data.report.instantly} · ${data.report.saleshandy} · ${data.report.domains} · ${data.report.scoring}`
          : "Sync finished.",
      );
    } catch (e) {
      setNotice(`Sync failed: ${e instanceof Error ? e.message : e}`);
    }
    setBusy(null);
    load();
  };

  const runPlacement = async () => {
    setBusy("Starting placement test batch…");
    try {
      const res = await fetch("/api/placement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchSize: 50 }),
      });
      const data = await res.json();
      setNotice(
        data.ok
          ? `Placement test started for ${data.senders} senders. Results appear after the test completes (check back in ~30 min).`
          : `Could not start test: ${data.error}`,
      );
    } catch (e) {
      setNotice(`Placement test failed: ${e instanceof Error ? e.message : e}`);
    }
    setBusy(null);
  };

  const doAction = async (action: string, value?: number) => {
    const emails = [...selected];
    if (emails.length === 0) return;
    setBusy(`Applying "${action}" to ${emails.length} sender(s)…`);
    const res = await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, emails, value }),
    });
    const data = await res.json();
    const failed = (data.results ?? []).filter((r: { ok: boolean }) => !r.ok);
    setNotice(
      failed.length === 0
        ? `Done — ${emails.length} sender(s) updated in Instantly.`
        : `${emails.length - failed.length} ok, ${failed.length} failed (first error: ${failed[0].error})`,
    );
    setBusy(null);
    setSelected(new Set());
    load();
  };

  const resolveAlert = async (id: number) => {
    await fetch("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    load();
  };

  const exportPauseList = () => {
    const rows = senders.filter((s) => s.health_status === "red" || s.health_status === "yellow");
    const csv = [
      "email,status,score,bounce_rate,google,microsoft",
      ...rows.map(
        (s) =>
          `${s.email},${s.health_status},${s.combined_score ?? ""},${s.bounce_rate ?? ""},${s.google_verdict ?? ""},${s.microsoft_verdict ?? ""}`,
      ),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `mailpulse-pause-list-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(senders.map((s) => s.email)) : new Set());
  };

  const total = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );

  return (
    <div className="mx-auto max-w-7xl p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">MailPulse</h1>
          <p className="text-sm text-zinc-500">
            Deliverability health for {total} sender{total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={runSync} disabled={!!busy} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50">
            Sync now
          </button>
          <button onClick={runPlacement} disabled={!!busy} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50">
            Run placement test (next 50)
          </button>
          <button onClick={exportPauseList} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50">
            Export pause list
          </button>
          <a href="/settings" className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50">
            Settings
          </a>
        </div>
      </header>

      {(busy || notice) && (
        <div className={`mb-4 rounded-lg px-4 py-3 text-sm ${busy ? "bg-blue-50 text-blue-800" : "bg-zinc-100 text-zinc-700"}`}>
          {busy ?? notice}
        </div>
      )}

      {/* Status summary */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["green", "yellow", "red", "unknown"] as const).map((st) => (
          <button
            key={st}
            onClick={() => setStatusFilter(statusFilter === st ? "" : st)}
            className={`rounded-xl border p-4 text-left transition ${statusFilter === st ? "border-zinc-900 ring-1 ring-zinc-900" : "border-zinc-200 hover:border-zinc-400"}`}
          >
            <div className="flex items-center gap-2">
              <span className={`h-3 w-3 rounded-full ${STATUS_DOT[st]}`} />
              <span className="text-sm capitalize text-zinc-600">{st === "unknown" ? "no data yet" : st}</span>
            </div>
            <div className="mt-1 text-2xl font-bold">{counts[st] ?? 0}</div>
          </button>
        ))}
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50">
          <div className="border-b border-amber-200 px-4 py-2 text-sm font-semibold text-amber-900">
            ⚠️ {alerts.length} open alert{alerts.length === 1 ? "" : "s"}
          </div>
          <ul className="max-h-56 divide-y divide-amber-100 overflow-y-auto">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
                <span>
                  <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-semibold ${a.severity === "critical" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>
                    {a.severity}
                  </span>
                  {a.message}
                </span>
                <button onClick={() => resolveAlert(a.id)} className="shrink-0 text-xs text-zinc-500 underline hover:text-zinc-800">
                  dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Filters + bulk actions */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search email or domain…"
          className="w-64 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
        />
        <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm">
          <option value="">All providers</option>
          <option value="maildoso">Maildoso</option>
          <option value="google">Google</option>
          <option value="microsoft">Microsoft</option>
          <option value="other">Other</option>
        </select>
        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white">
            <span>{selected.size} selected</span>
            <button onClick={() => doAction("pause")} className="rounded bg-red-500 px-2 py-0.5 text-xs font-semibold hover:bg-red-400">Pause</button>
            <button onClick={() => doAction("resume")} className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-semibold hover:bg-emerald-500">Resume</button>
            <button
              onClick={() => {
                const v = prompt("New daily sending limit for selected senders:", "20");
                if (v && !Number.isNaN(Number(v))) doAction("set-limit", Number(v));
              }}
              className="rounded bg-amber-500 px-2 py-0.5 text-xs font-semibold hover:bg-amber-400"
            >
              Set limit…
            </button>
          </div>
        )}
      </div>

      {/* Senders table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="p-3">
                <input type="checkbox" checked={selected.size === senders.length && senders.length > 0} onChange={(e) => toggleAll(e.target.checked)} />
              </th>
              <th className="p-3">Sender</th>
              <th className="p-3">Provider</th>
              <th className="p-3">Score</th>
              <th className="p-3">Warmup</th>
              <th className="p-3">Bounce</th>
              <th className="p-3">Gmail</th>
              <th className="p-3">Microsoft</th>
              <th className="p-3">Auth</th>
              <th className="p-3">Limit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {senders.map((s) => (
              <tr key={s.email} className={s.instantly_status === 2 ? "bg-zinc-50 text-zinc-400" : ""}>
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={selected.has(s.email)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(s.email);
                      else next.delete(s.email);
                      setSelected(next);
                    }}
                  />
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[s.health_status] ?? STATUS_DOT.unknown}`} />
                    <span className="font-medium">{s.email}</span>
                    {isBlocklisted(s) && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-700">BLOCKLISTED</span>}
                    {s.instantly_status === 2 && <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs">paused</span>}
                  </div>
                </td>
                <td className="p-3">{PROVIDER_LABEL[s.provider] ?? s.provider}</td>
                <td className="p-3 font-semibold">{s.combined_score ?? "—"}</td>
                <td className="p-3">{s.warmup_score ?? "—"}</td>
                <td className="p-3">{s.bounce_rate != null ? `${s.bounce_rate}%` : "—"}</td>
                <td className="p-3">{verdictBadge(s.google_verdict)}</td>
                <td className="p-3">{verdictBadge(s.microsoft_verdict)}</td>
                <td className="p-3">
                  <span title="SPF / DKIM / DMARC" className="font-mono text-xs">
                    {authFlag(s.spf_ok)} {authFlag(s.dkim_ok)} {authFlag(s.dmarc_ok)}
                  </span>
                </td>
                <td className="p-3">{s.daily_limit ?? "—"}</td>
              </tr>
            ))}
            {senders.length === 0 && (
              <tr>
                <td colSpan={10} className="p-8 text-center text-zinc-500">
                  No senders yet. Add your API keys in <a href="/settings" className="underline">Settings</a>, then hit <b>Sync now</b>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function verdictBadge(v: string | null) {
  if (!v) return <span className="text-zinc-400">—</span>;
  const cls =
    v === "inbox"
      ? "bg-emerald-100 text-emerald-700"
      : v === "spam"
        ? "bg-red-100 text-red-700"
        : "bg-zinc-100 text-zinc-600";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${cls}`}>{v}</span>;
}

function authFlag(ok: number | null) {
  if (ok == null) return "·";
  return ok ? "✓" : "✗";
}
