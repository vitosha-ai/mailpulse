"use client";

import { useEffect, useMemo, useState } from "react";

// Cold-call scoreboard on the Outbound landing screen. Data is pushed nightly
// by the Zoom Phone EOD job (a separate Railway service) to /api/outbound/calls.
// The range selector lets the team look back up to the last two months.

type CallRow = {
  report_date: string;
  email: string;
  name: string | null;
  calls: number;
  outbound: number;
  inbound: number;
  connected: number;
  connect_rate: number;
  talk_seconds: number;
  avg_seconds: number;
  conversations: number;
};

type Agg = {
  email: string;
  name: string;
  calls: number;
  outbound: number;
  inbound: number;
  connected: number;
  talk_seconds: number;
  conversations: number;
};

const RANGES = [
  { key: "1", label: "Latest day", days: 1 },
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "60", label: "2 months", days: 60 },
] as const;

function hhmmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

// "2026-07-24" → "Thu, Jul 24"
function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export default function CallActivityWidget() {
  const [rows, setRows] = useState<CallRow[]>([]);
  const [daysPresent, setDaysPresent] = useState<string[]>([]);
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("1");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/outbound/calls?days=60`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setRows(Array.isArray(d.rows) ? d.rows : []);
        setDaysPresent(Array.isArray(d.days_present) ? d.days_present : []);
        setError(false);
      })
      .catch(() => alive && setError(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // The window of days the selected range covers (from the days actually present).
  const activeDays = useMemo(() => {
    const n = RANGES.find((r) => r.key === range)?.days ?? 1;
    return new Set(daysPresent.slice(0, n));
  }, [range, daysPresent]);

  // Aggregate per rep across the active window (sum activity, recompute rates).
  const agg = useMemo(() => {
    const by = new Map<string, Agg>();
    for (const r of rows) {
      if (!activeDays.has(r.report_date)) continue;
      const cur =
        by.get(r.email) ??
        {
          email: r.email,
          name: r.name || r.email,
          calls: 0, outbound: 0, inbound: 0, connected: 0, talk_seconds: 0, conversations: 0,
        };
      cur.calls += r.calls;
      cur.outbound += r.outbound;
      cur.inbound += r.inbound;
      cur.connected += r.connected;
      cur.talk_seconds += r.talk_seconds;
      cur.conversations += r.conversations;
      cur.name = r.name || cur.name;
      by.set(r.email, cur);
    }
    return Array.from(by.values()).sort((a, b) => b.calls - a.calls);
  }, [rows, activeDays]);

  const team = useMemo(() => {
    const t = { calls: 0, outbound: 0, inbound: 0, connected: 0, talk_seconds: 0, conversations: 0 };
    for (const a of agg) {
      t.calls += a.calls; t.outbound += a.outbound; t.inbound += a.inbound;
      t.connected += a.connected; t.talk_seconds += a.talk_seconds; t.conversations += a.conversations;
    }
    return t;
  }, [agg]);

  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? "";
  const windowHint =
    range === "1"
      ? daysPresent[0]
        ? fmtDay(daysPresent[0])
        : "no data yet"
      : `${activeDays.size} day${activeDays.size === 1 ? "" : "s"} with data`;

  const rate = (connected: number, calls: number) => (calls ? Math.round((100 * connected) / calls) : 0);
  const avg = (talk: number, connected: number) => (connected ? Math.round(talk / connected) : 0);

  return (
    <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <span aria-hidden>📞</span> Cold calls
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Zoom Phone activity · {rangeLabel.toLowerCase()} · {windowHint}
          </p>
        </div>
        <div className="flex items-center rounded-lg border border-slate-300 bg-white shadow-sm">
          {RANGES.map((r, i) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`px-3 py-1.5 text-xs font-medium transition ${i === 0 ? "rounded-l-lg" : ""} ${
                i === RANGES.length - 1 ? "rounded-r-lg" : ""
              } ${range === r.key ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="py-6 text-center text-sm text-slate-400">Loading call activity…</p>
      ) : error ? (
        <p className="py-6 text-center text-sm text-slate-400">Couldn&apos;t load call activity.</p>
      ) : agg.length === 0 ? (
        <p className="rounded-xl bg-slate-50 py-6 text-center text-sm text-slate-500">
          No call data for this range yet. The 6pm Zoom job writes here each evening.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left font-mono text-[10px] uppercase tracking-wider text-slate-500">
                <th className="py-2 pr-3">Rep</th>
                <th className="px-3 py-2 text-right">Calls</th>
                <th className="px-3 py-2 text-right">Out</th>
                <th className="px-3 py-2 text-right">In</th>
                <th className="px-3 py-2 text-right">Connected</th>
                <th className="px-3 py-2 text-right">Connect rate</th>
                <th className="px-3 py-2 text-right">Talk time</th>
                <th className="px-3 py-2 text-right">Convos</th>
              </tr>
            </thead>
            <tbody>
              {agg.map((a) => (
                <tr key={a.email} className="border-b border-slate-50 text-slate-700">
                  <td className="py-2 pr-3 font-medium text-slate-900">{a.name}</td>
                  <td className={`px-3 py-2 text-right ${a.calls === 0 ? "text-red-400" : ""}`}>{a.calls}</td>
                  <td className="px-3 py-2 text-right">{a.outbound}</td>
                  <td className="px-3 py-2 text-right">{a.inbound}</td>
                  <td className="px-3 py-2 text-right">{a.connected}</td>
                  <td className="px-3 py-2 text-right">{rate(a.connected, a.calls)}%</td>
                  <td className="px-3 py-2 text-right">{hhmmss(a.talk_seconds)}</td>
                  <td className="px-3 py-2 text-right">{a.conversations}</td>
                </tr>
              ))}
              <tr className="font-semibold text-slate-900">
                <td className="py-2 pr-3">Team</td>
                <td className="px-3 py-2 text-right">{team.calls}</td>
                <td className="px-3 py-2 text-right">{team.outbound}</td>
                <td className="px-3 py-2 text-right">{team.inbound}</td>
                <td className="px-3 py-2 text-right">{team.connected}</td>
                <td className="px-3 py-2 text-right">{rate(team.connected, team.calls)}%</td>
                <td className="px-3 py-2 text-right">{hhmmss(team.talk_seconds)}</td>
                <td className="px-3 py-2 text-right">{team.conversations}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-[11px] text-slate-400">
            A conversation is a connected call of 2 minutes or more. Avg team connected call:{" "}
            {hhmmss(avg(team.talk_seconds, team.connected))}.
          </p>
        </div>
      )}
    </div>
  );
}
