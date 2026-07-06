"use client";

import { useState } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Read the live input value — browser autofill can populate the field
    // without React noticing.
    const field = e.currentTarget.elements.namedItem("password") as HTMLInputElement | null;
    const value = field?.value ?? password;
    if (!value) {
      setError("Type the team password first.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: value }),
    });
    if (res.ok) {
      window.location.href = "/";
    } else {
      setError("Wrong password — ask the person who shared the link.");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#070b14] bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(34,211,238,0.13),transparent)] text-slate-200">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/60 p-8 backdrop-blur"
      >
        <div className="mb-6 flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.9)]" />
          </span>
          <h1 className="bg-gradient-to-r from-cyan-300 via-sky-200 to-emerald-300 bg-clip-text text-2xl font-bold tracking-tight text-transparent">
            MailPulse
          </h1>
        </div>
        <label className="mb-2 block font-mono text-[11px] uppercase tracking-widest text-slate-400">
          Team password
        </label>
        <input
          type="password"
          name="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 font-mono text-sm text-slate-200 outline-none transition focus:border-cyan-500/60 focus:shadow-[0_0_14px_rgba(34,211,238,0.15)]"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 shadow-[0_0_18px_rgba(34,211,238,0.35)] transition hover:shadow-[0_0_26px_rgba(34,211,238,0.55)] disabled:opacity-40"
        >
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
