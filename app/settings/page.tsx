"use client";

import { useEffect, useState } from "react";

const FIELDS = [
  {
    key: "instantly_api_key",
    label: "Instantly API key",
    help: "Instantly → Settings → Integrations → API keys. Needed for warmup health scores, placement tests, and pause/resume actions.",
  },
  {
    key: "saleshandy_api_key",
    label: "Saleshandy API key",
    help: "Saleshandy → Settings → API (requires Pro plan or higher). Adds bounce rates and campaign-side scores.",
  },
  {
    key: "smartlead_api_key",
    label: "Smartlead API key",
    help: "Smartlead → Settings → Smartlead API key. Brings in your Smartlead sender accounts, their warmup reputation, and — importantly — disconnect detection (Smartlead silently skips disconnected mailboxes in campaigns).",
  },
  {
    key: "spamhaus_dqs_key",
    label: "Spamhaus DQS key (free)",
    help: "Sign up free at spamhaus.com → Data Query Service. Without it, blocklist checks may be refused by Spamhaus.",
  },
] as const;

export default function Settings() {
  const [masked, setMasked] = useState<Record<string, string | null>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/settings");
    setMasked(await res.json());
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (key: string) => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: values[key] ?? "" }),
    });
    setSaved(key);
    setValues((v) => ({ ...v, [key]: "" }));
    setTimeout(() => setSaved(null), 2000);
    load();
  };

  return (
    <div className="min-h-screen bg-[#070b14] bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(34,211,238,0.13),transparent)] text-slate-200">
      <div className="mx-auto max-w-2xl p-6">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-cyan-300 via-sky-200 to-emerald-300 bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              Settings
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-500">
              api keys · stored locally only
            </p>
          </div>
          <a
            href="/"
            className="rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-2 text-sm font-medium text-slate-300 backdrop-blur transition hover:border-slate-500 hover:text-white"
          >
            ← Dashboard
          </a>
        </header>

        <div className="space-y-5">
          {FIELDS.map((f) => (
            <div
              key={f.key}
              className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur transition hover:border-slate-700"
            >
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-slate-100">{f.label}</label>
                {masked[f.key] ? (
                  <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
                    configured
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-amber-300">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                    not configured
                  </span>
                )}
              </div>
              <p className="mb-3 mt-1 text-xs leading-relaxed text-slate-500">{f.help}</p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={masked[f.key] ? `Saved: ${masked[f.key]} — paste to replace` : "Paste key here"}
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 font-mono text-sm text-slate-200 placeholder-slate-600 outline-none transition focus:border-cyan-500/60 focus:shadow-[0_0_14px_rgba(34,211,238,0.15)]"
                />
                <button
                  onClick={() => save(f.key)}
                  disabled={!values[f.key]}
                  className="rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 px-5 py-2 text-sm font-semibold text-slate-950 shadow-[0_0_14px_rgba(34,211,238,0.3)] transition hover:shadow-[0_0_22px_rgba(34,211,238,0.5)] disabled:opacity-30 disabled:shadow-none"
                >
                  {saved === f.key ? "Saved ✓" : "Save"}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900/30 p-5 text-sm text-slate-400 backdrop-blur">
          <p className="font-mono text-[11px] uppercase tracking-widest text-slate-500">
            Reminder — one-time purchases
          </p>
          <ul className="mt-3 space-y-2">
            <li className="flex gap-2">
              <span className="text-cyan-400">›</span>
              <span>
                Instantly <b className="text-slate-200">Inbox Placement add-on</b> ($47/mo, Growth tier) —
                required for the real Gmail/Microsoft placement tests. Warmup scores work without it.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-cyan-400">›</span>
              <span>Saleshandy Pro+ plan for API access (you likely already have it).</span>
            </li>
            <li className="flex gap-2">
              <span className="text-cyan-400">›</span>
              <span>Spamhaus DQS is free — just needs the signup.</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
