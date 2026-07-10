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
    <div className="flex min-h-screen items-center justify-center bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(11,64,176,0.14),transparent)] text-slate-800">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-md"
      >
        <div className="mb-6 flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-brand" />
          </span>
          <h1 className="bg-gradient-to-r from-brand via-brand-light to-brand-dark bg-clip-text text-2xl font-bold tracking-tight text-transparent">
            MailPulse
          </h1>
        </div>
        <label className="mb-2 block font-mono text-[11px] uppercase tracking-widest text-slate-500">
          Team password
        </label>
        <input
          type="password"
          name="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="mb-3 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand/40"
        />
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-gradient-to-r from-brand to-brand-light px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-dark hover:to-brand disabled:opacity-40"
        >
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
