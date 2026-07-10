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
    key: "trulyinbox_api_key",
    label: "TrulyInbox API key",
    help: "TrulyInbox → API Keys tab (needs Starter plan or higher). Brings warmup deliverability scores and inbox/spam rates for the mailboxes warmed in TrulyInbox.",
  },
  {
    key: "spamhaus_dqs_key",
    label: "Spamhaus DQS key (free)",
    help: "Sign up free at spamhaus.com → Data Query Service. Without it, blocklist checks may be refused by Spamhaus.",
  },
  {
    key: "maildoso_api_key",
    label: "Maildoso API key (for the Inbox)",
    help: "Maildoso → Settings → API / Personal Access Token. MailPulse uses it to auto-connect to your master inbox (@maildoso.email) and read real replies — warmup mail is filtered out. Easiest option; no IMAP details needed.",
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
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <div className="mx-auto max-w-2xl p-6">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              Settings
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              api keys · stored securely, shown masked
            </p>
          </div>
          <a
            href="/"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400 hover:text-slate-900"
          >
            ← Dashboard
          </a>
        </header>

        <div className="space-y-5">
          {FIELDS.map((f) => (
            <div
              key={f.key}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300"
            >
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-slate-900">{f.label}</label>
                {masked[f.key] ? (
                  <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-emerald-600">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    configured
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-amber-600">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
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
                  className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand/40"
                />
                <button
                  onClick={() => save(f.key)}
                  disabled={!values[f.key]}
                  className="rounded-lg bg-gradient-to-r from-brand to-brand-light px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-dark hover:to-brand disabled:opacity-30"
                >
                  {saved === f.key ? "Saved ✓" : "Save"}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Google Workspace inbox reader */}
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <label className="text-sm font-semibold text-slate-900">Google Workspace — inbox reader</label>
          {masked.google_sa_json ? (
            <span className="ml-2 font-mono text-[11px] uppercase tracking-wider text-emerald-600">✓ configured</span>
          ) : null}
          <p className="mb-3 mt-1 text-xs leading-relaxed text-slate-500">
            Paste the <b>service-account JSON key</b> (the file you downloaded from Google Cloud) to read this
            workspace&apos;s mailbox replies centrally. Then set the workspace <b>domains</b> below (comma-separated,
            e.g. <code>vitoshaamplify.com, vitoshaboost.com</code>) so MailPulse knows which mailboxes it covers.
          </p>
          <textarea
            value={values.google_sa_json ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, google_sa_json: e.target.value }))}
            placeholder={masked.google_sa_json ? "Saved — paste new JSON to replace" : '{ "type": "service_account", "client_email": "...", "private_key": "..." }'}
            rows={4}
            className="mb-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 placeholder-slate-400 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand/40"
          />
          <div className="flex gap-2">
            <input
              value={values.google_domains ?? masked.google_domains ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, google_domains: e.target.value }))}
              placeholder="workspace domains, comma-separated"
              className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand/40"
            />
            <button
              onClick={async () => {
                if (values.google_sa_json) await save("google_sa_json");
                await save("google_domains");
              }}
              className="rounded-lg bg-gradient-to-r from-brand to-brand-light px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-dark hover:to-brand"
            >
              {saved === "google_domains" || saved === "google_sa_json" ? "Saved ✓" : "Save"}
            </button>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
          <p className="font-mono text-[11px] uppercase tracking-widest text-slate-400">
            Reminder — one-time purchases
          </p>
          <ul className="mt-3 space-y-2">
            <li className="flex gap-2">
              <span className="text-brand">›</span>
              <span>
                Instantly <b className="text-slate-800">Inbox Placement add-on</b> ($47/mo, Growth tier) —
                required for the real Gmail/Microsoft placement tests. Warmup scores work without it.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand">›</span>
              <span>Saleshandy Pro+ plan for API access (you likely already have it).</span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand">›</span>
              <span>Spamhaus DQS is free — just needs the signup.</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
