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
  retire_requested: string | null;
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

const STATUS_META: Record<string, { dot: string; label: string; text: string }> = {
  green: { dot: "bg-emerald-500", label: "Healthy", text: "text-emerald-600" },
  yellow: { dot: "bg-amber-500", label: "Degrading", text: "text-amber-600" },
  red: { dot: "bg-red-500", label: "Critical", text: "text-red-600" },
  unknown: { dot: "bg-slate-400", label: "No data", text: "text-slate-500" },
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

function scoreColor(score: number | null): string {
  if (score === null) return "text-slate-400";
  if (score >= 80) return "text-emerald-600";
  if (score >= 60) return "text-amber-600";
  return "text-red-600";
}

function scoreBarColor(score: number | null): string {
  if (score === null) return "bg-slate-300";
  if (score >= 80) return "bg-gradient-to-r from-emerald-500 to-teal-400";
  if (score >= 60) return "bg-gradient-to-r from-amber-500 to-yellow-400";
  return "bg-gradient-to-r from-red-500 to-orange-400";
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
  const [keys, setKeys] = useState<Record<string, string | null> | null>(null);

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

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setKeys)
      .catch(() => {});
  }, []);

  const runSync = async () => {
    setBusy("Syncing with Instantly + Saleshandy + DNS — this can take a few minutes…");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setNotice(
        data.report
          ? `Sync done. ${data.report.instantly} · ${data.report.saleshandy} · ${data.report.smartlead} · ${data.report.trulyinbox} · ${data.report.domains} · ${data.report.scoring}`
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
        ? `Done — ${emails.length} sender(s) updated.`
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
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(14,165,233,0.10),transparent),radial-gradient(ellipse_40%_30%_at_90%_10%,rgba(16,185,129,0.07),transparent)] text-slate-800">
      <div className="mx-auto max-w-[1600px] p-6">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-60" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-sky-500" />
              </span>
              <h1 className="bg-gradient-to-r from-sky-600 via-cyan-600 to-emerald-600 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
                MailPulse
              </h1>
            </div>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              sender fleet · {total} mailboxes monitored
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={runSync}
              disabled={!!busy}
              className="rounded-lg bg-gradient-to-r from-sky-500 to-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-sky-600 hover:to-emerald-600 disabled:opacity-40"
            >
              ⟳ Sync now
            </button>
            <button
              onClick={runPlacement}
              disabled={!!busy}
              className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-700 transition hover:border-sky-400 hover:bg-sky-100 disabled:opacity-40"
            >
              ▶ Placement test (next 50)
            </button>
            <button
              onClick={exportPauseList}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
            >
              ⤓ Export pause list
            </button>
            <a
              href="/settings"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
            >
              ⚙ Settings
            </a>
          </div>
        </header>

        {(busy || notice) && (
          <div
            className={`mb-5 rounded-xl border px-4 py-3 text-sm ${
              busy
                ? "border-sky-300 bg-sky-50 text-sky-800"
                : "border-slate-200 bg-white text-slate-600 shadow-sm"
            }`}
          >
            {busy ? (
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
                {busy}
              </span>
            ) : (
              notice
            )}
          </div>
        )}

        {/* Setup checklist — shows until everything is connected */}
        {keys && (!keys.instantly_api_key || !keys.saleshandy_api_key || !keys.spamhaus_dqs_key || total === 0) && (
          <div className="mb-6 rounded-2xl border border-sky-200 bg-sky-50 p-5">
            <p className="font-mono text-[11px] uppercase tracking-widest text-sky-600">
              Getting started
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              <ChecklistItem
                done={!!keys.instantly_api_key}
                label="Connect Instantly"
                detail="Paste your Instantly API key in Settings — this brings in all your mailboxes and their warmup health scores."
              />
              <ChecklistItem
                done={total > 0}
                label="Run your first sync"
                detail="Click ⟳ Sync now (top right). Your senders appear here with scores within a few minutes."
              />
              <ChecklistItem
                done={!!keys.saleshandy_api_key}
                label="Connect Saleshandy (optional but recommended)"
                detail="Adds bounce rates from your real campaigns — an early warning sign the warmup data can miss."
              />
              <ChecklistItem
                done={!!keys.smartlead_api_key}
                label="Connect Smartlead (if you use it)"
                detail="Brings in your Smartlead senders and alerts you when one silently disconnects — Smartlead skips those in campaigns without telling you."
              />
              <ChecklistItem
                done={!!keys.trulyinbox_api_key}
                label="Connect TrulyInbox (if you warm mailboxes there)"
                detail="Adds warmup deliverability scores and inbox/spam trends for the mailboxes not warmed in Instantly."
              />
              <ChecklistItem
                done={!!keys.spamhaus_dqs_key}
                label="Add the free Spamhaus key (optional)"
                detail="Lets the app check whether your domains are on spam blocklists — the most serious red flag there is."
              />
            </ul>
            <a
              href="/settings"
              className="mt-4 inline-block rounded-lg border border-sky-300 bg-sky-100 px-4 py-2 text-sm font-medium text-sky-700 transition hover:bg-sky-200"
            >
              Open Settings →
            </a>
          </div>
        )}

        {/* Status summary */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["green", "yellow", "red", "unknown"] as const).map((st) => {
            const m = STATUS_META[st];
            const active = statusFilter === st;
            return (
              <button
                key={st}
                onClick={() => setStatusFilter(active ? "" : st)}
                className={`group rounded-2xl border p-4 text-left shadow-sm transition ${
                  active
                    ? "border-sky-400 bg-sky-50 ring-1 ring-sky-300"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${m.dot}`} />
                  <span className="font-mono text-[11px] uppercase tracking-widest text-slate-500">
                    {m.label}
                  </span>
                </div>
                <div className={`mt-2 text-3xl font-bold tabular-nums ${m.text}`}>
                  {counts[st] ?? 0}
                </div>
              </button>
            );
          })}
        </div>

        {/* Alerts */}
        {alerts.length > 0 && (
          <div className="mb-6 overflow-hidden rounded-2xl border border-amber-300 bg-amber-50 shadow-sm">
            <div className="flex items-center gap-2 border-b border-amber-200 px-4 py-2.5 text-sm font-semibold text-amber-800">
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              {alerts.length} open alert{alerts.length === 1 ? "" : "s"}
            </div>
            <ul className="max-h-56 divide-y divide-amber-100 overflow-y-auto">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="text-slate-700">
                    <span
                      className={`mr-2 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${
                        a.severity === "critical"
                          ? "bg-red-100 text-red-700 ring-1 ring-red-300"
                          : "bg-amber-100 text-amber-700 ring-1 ring-amber-300"
                      }`}
                    >
                      {a.severity}
                    </span>
                    {a.message}
                  </span>
                  <button
                    onClick={() => resolveAlert(a.id)}
                    className="shrink-0 font-mono text-xs text-slate-400 transition hover:text-slate-700"
                  >
                    dismiss ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Plain-English guide */}
        <details className="mb-4 rounded-2xl border border-slate-200 bg-white shadow-sm">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-slate-600 transition hover:text-slate-900">
            💡 How to read this dashboard
          </summary>
          <div className="grid gap-x-6 gap-y-3 border-t border-slate-200 px-4 py-4 text-sm leading-relaxed text-slate-600 sm:grid-cols-2">
            <p>
              <b className="text-slate-900">Score</b> — the overall health of a sender, 0–100. It blends
              real placement tests, warmup results, bounce rate, and domain setup. <b className="text-emerald-600">80+ is healthy</b>,{" "}
              <b className="text-amber-600">60–79 needs attention</b>, <b className="text-red-600">below 60 means stop sending</b>.
            </p>
            <p>
              <b className="text-slate-900">Warmup</b> — Instantly&apos;s 0–100 health score from warmup activity.
              If this slides down day after day, the mailbox is heading for the spam folder.
            </p>
            <p>
              <b className="text-slate-900">Bounce</b> — % of your real campaign emails that bounced (from
              Saleshandy). Above 3% is a problem; above 8% is urgent.
            </p>
            <p>
              <b className="text-slate-900">Gmail / Microsoft</b> — the verdict from the latest real placement
              test: did a test email from this sender land in the <b className="text-emerald-600">inbox</b> or in{" "}
              <b className="text-red-600">spam</b> at that provider?
            </p>
            <p>
              <b className="text-slate-900">Auth (✓✓✓)</b> — three checkmarks for SPF, DKIM and DMARC: the DNS
              records that prove your emails aren&apos;t forged. Any ✗ hurts deliverability and is usually a
              quick fix at your domain provider.
            </p>
            <p>
              <b className="text-slate-900">Action</b> — what we recommend doing with this sender right now.
              Select rows with the checkboxes to Pause / Retire / Resume / Set limit in bulk — changes are
              pushed straight to the sending platform.
            </p>
          </div>
        </details>

        {/* Filters + bulk actions */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="⌕ search email or domain…"
            className="w-72 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 shadow-sm outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-300"
          />
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-600 shadow-sm outline-none focus:border-sky-400"
          >
            <option value="">All providers</option>
            <option value="maildoso">Maildoso</option>
            <option value="google">Google</option>
            <option value="microsoft">Microsoft</option>
            <option value="other">Other</option>
          </select>
          {selected.size > 0 && (
            <div className="ml-auto flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 shadow-md">
              <span className="font-mono text-xs text-sky-600">{selected.size} selected</span>
              <button
                onClick={() => doAction("pause")}
                className="rounded-md bg-red-500 px-2.5 py-1 text-xs font-bold text-white transition hover:bg-red-600"
              >
                ⏸ Pause
              </button>
              <button
                onClick={() => doAction("retire")}
                title="Graceful pause: keeps follow-ups flowing at 10/day, then fully pauses once this sender's campaigns finish"
                className="rounded-md bg-sky-500 px-2.5 py-1 text-xs font-bold text-white transition hover:bg-sky-600"
              >
                ◐ Retire
              </button>
              <button
                onClick={() => doAction("resume")}
                className="rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-bold text-white transition hover:bg-emerald-600"
              >
                ▶ Resume
              </button>
              <button
                onClick={() => {
                  const v = prompt("New daily sending limit for selected senders:", "20");
                  if (v && !Number.isNaN(Number(v))) doAction("set-limit", Number(v));
                }}
                className="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-bold text-white transition hover:bg-amber-600"
              >
                ↓ Set limit…
              </button>
            </div>
          )}
        </div>

        {/* Senders table */}
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.size === senders.length && senders.length > 0}
                    onChange={(e) => toggleAll(e.target.checked)}
                    className="accent-sky-500"
                  />
                </th>
                <th className="px-3 py-2.5">Sender</th>
                <th className="px-3 py-2.5" title="Where this mailbox is hosted">Provider</th>
                <th className="px-3 py-2.5" title="Overall health, 0–100. 80+ healthy · 60–79 attention · <60 stop sending">Score</th>
                <th className="px-3 py-2.5" title="Instantly warmup health score (0–100)">Warmup</th>
                <th className="px-3 py-2.5" title="% of campaign emails that bounced. Above 3% is a problem">Bounce</th>
                <th className="px-3 py-2.5" title="Latest placement test verdict at Gmail">Gmail</th>
                <th className="px-3 py-2.5" title="Latest placement test verdict at Outlook/Microsoft 365">Microsoft</th>
                <th className="px-3 py-2.5" title="SPF / DKIM / DMARC — DNS records proving your mail isn't forged">Auth</th>
                <th className="px-3 py-2.5" title="Max emails per day this mailbox may send">Limit</th>
                <th className="px-3 py-2.5" title="Recommended next step for this sender">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {senders.map((s) => {
                const m = STATUS_META[s.health_status] ?? STATUS_META.unknown;
                return (
                  <tr
                    key={s.email}
                    className={`transition hover:bg-slate-50 ${s.instantly_status === 2 ? "opacity-50" : ""}`}
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(s.email)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(s.email);
                          else next.delete(s.email);
                          setSelected(next);
                        }}
                        className="accent-sky-500"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${m.dot}`} />
                        <span className="font-mono text-[13px] text-slate-700">{s.email}</span>
                        {isBlocklisted(s) && (
                          <span className="rounded-md bg-red-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-red-700 ring-1 ring-red-300">
                            BLOCKLISTED
                          </span>
                        )}
                        {s.instantly_status === 2 && (
                          <span className="rounded-md bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                            PAUSED
                          </span>
                        )}
                        {s.retire_requested && (
                          <span
                            title="Graceful pause in progress: follow-ups still flowing; fully pauses when its campaigns finish"
                            className="rounded-md bg-sky-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-700 ring-1 ring-sky-300"
                          >
                            RETIRING
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{PROVIDER_LABEL[s.provider] ?? s.provider}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className={`w-10 font-mono text-sm font-bold tabular-nums ${scoreColor(s.combined_score)}`}>
                          {s.combined_score ?? "—"}
                        </span>
                        <span className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-200">
                          <span
                            className={`block h-full rounded-full ${scoreBarColor(s.combined_score)}`}
                            style={{ width: `${s.combined_score ?? 0}%` }}
                          />
                        </span>
                      </div>
                    </td>
                    <td className={`p-3 font-mono tabular-nums ${scoreColor(s.warmup_score)}`}>
                      {s.warmup_score ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-slate-600">
                      {s.bounce_rate != null ? `${s.bounce_rate}%` : "—"}
                    </td>
                    <td className="px-3 py-2.5">{verdictBadge(s.google_verdict)}</td>
                    <td className="px-3 py-2.5">{verdictBadge(s.microsoft_verdict)}</td>
                    <td className="px-3 py-2.5">
                      <span title="SPF / DKIM / DMARC" className="font-mono text-xs tracking-widest">
                        {authFlag(s.spf_ok)}
                        {authFlag(s.dkim_ok)}
                        {authFlag(s.dmarc_ok)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-slate-500">{s.daily_limit ?? "—"}</td>
                    <td className="px-3 py-2.5">{actionChip(s)}</td>
                  </tr>
                );
              })}
              {senders.length === 0 && (
                <tr>
                  <td colSpan={11} className="p-10 text-center text-slate-400">
                    No senders yet. Add your API keys in{" "}
                    <a href="/settings" className="text-sky-600 underline decoration-sky-300 hover:text-sky-700">
                      Settings
                    </a>
                    , then hit <b className="text-slate-600">⟳ Sync now</b>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ChecklistItem({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
          done
            ? "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-400"
            : "bg-slate-100 text-slate-400 ring-1 ring-slate-300"
        }`}
      >
        {done ? "✓" : ""}
      </span>
      <span>
        <span className={done ? "text-slate-400 line-through" : "text-slate-800"}>{label}</span>
        {!done && <span className="block text-xs text-slate-500">{detail}</span>}
      </span>
    </li>
  );
}

function actionChip(s: Sender) {
  if (s.instantly_status === 2) {
    return (
      <span
        title="This sender is paused. Resume it once its score recovers (usually after 2–3 weeks of warmup-only rest)."
        className="whitespace-nowrap rounded-md bg-slate-100 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500 ring-1 ring-slate-300"
      >
        resting
      </span>
    );
  }
  switch (s.health_status) {
    case "green":
      return (
        <span
          title="Healthy — keep sending at the current volume."
          className="whitespace-nowrap rounded-md bg-emerald-50 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-300"
        >
          ✓ healthy
        </span>
      );
    case "yellow":
      return (
        <span
          title="Degrading — select this row and use “Set limit…” to cut its daily volume roughly in half, then watch it for a few days."
          className="whitespace-nowrap rounded-md bg-amber-50 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-300"
        >
          ↓ slow
        </span>
      );
    case "red":
      return (
        <span
          title="Critical — select this row and hit Pause. Keep warmup running; revisit in 2–3 weeks."
          className="whitespace-nowrap rounded-md bg-red-50 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-red-700 ring-1 ring-red-300"
        >
          ⏸ pause
        </span>
      );
    default:
      return (
        <span
          title="No data yet — run a sync (and a placement test) to score this sender."
          className="whitespace-nowrap rounded-md bg-slate-100 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-slate-500 ring-1 ring-slate-300"
        >
          ⟳ sync
        </span>
      );
  }
}

function verdictBadge(v: string | null) {
  if (!v) return <span className="text-slate-300">—</span>;
  const cls =
    v === "inbox"
      ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300"
      : v === "spam"
        ? "bg-red-50 text-red-700 ring-1 ring-red-300"
        : "bg-slate-100 text-slate-500 ring-1 ring-slate-300";
  return (
    <span className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${cls}`}>
      {v}
    </span>
  );
}

function authFlag(ok: number | null) {
  if (ok == null) return <span className="text-slate-300">·</span>;
  return ok ? <span className="text-emerald-600">✓</span> : <span className="text-red-500">✗</span>;
}
