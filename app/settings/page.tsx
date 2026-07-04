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
    <div className="mx-auto max-w-2xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <a href="/" className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50">
          ← Dashboard
        </a>
      </header>

      <div className="space-y-6">
        {FIELDS.map((f) => (
          <div key={f.key} className="rounded-xl border border-zinc-200 p-4">
            <label className="block text-sm font-semibold">{f.label}</label>
            <p className="mb-2 mt-1 text-xs text-zinc-500">{f.help}</p>
            <div className="flex gap-2">
              <input
                type="password"
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={masked[f.key] ? `Saved: ${masked[f.key]} — paste to replace` : "Paste key here"}
                className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              />
              <button
                onClick={() => save(f.key)}
                disabled={!values[f.key]}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
              >
                {saved === f.key ? "Saved ✓" : "Save"}
              </button>
            </div>
            <div className="mt-1 text-xs">
              {masked[f.key] ? (
                <span className="text-emerald-600">✓ configured</span>
              ) : (
                <span className="text-amber-600">not configured</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-600">
        <p className="font-semibold">Reminder — one-time purchases:</p>
        <ul className="mt-2 list-disc pl-5">
          <li>
            Instantly <b>Inbox Placement add-on</b> ($47/mo, Growth tier) — required for the real
            Gmail/Microsoft placement tests. Warmup scores work without it.
          </li>
          <li>Saleshandy Pro+ plan for API access (you likely already have it).</li>
          <li>Spamhaus DQS is free — just needs the signup.</li>
        </ul>
      </div>
    </div>
  );
}
