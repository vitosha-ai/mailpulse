"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Team module — the RBAC + allocation home for ALL agents (US, GCC, staffing).
// Three sections: (1) Team access — admins + SDR invites, (2) Lead assignment
// across every market, (3) SDR login audit trail. Admin-only (password gate).

type AdminRow = { id: number; name: string; email: string; role: string; active: number; has_key: number };
type SdrRow = { id: number; name: string; email: string; active: number };
type LoginRow = { sdr: string; ip: string; city: string | null; country: string | null; user_agent: string | null; created_at: string };
type Lead = {
  id: number; queued_date: string; company: string | null;
  first_name: string | null; last_name: string | null; title: string | null;
  trigger_type: string | null; trigger_detail: string | null;
  detected_stack: string | null; status: string; sdr: string | null; market: string | null;
};

const MARKET_BADGE: Record<string, string> = {
  us: "bg-slate-100 text-slate-500",
  gcc: "bg-teal-100 text-teal-700",
  healthcare: "bg-rose-100 text-rose-700",
  staffing: "bg-violet-100 text-violet-700",
};
const MARKET_LABELS: Record<string, string> = { us: "US", gcc: "GCC", healthcare: "Healthcare", staffing: "Staffing" };

export default function TeamPage() {
  const [sdrs, setSdrs] = useState<SdrRow[]>([]);
  const [logins, setLogins] = useState<LoginRow[]>([]);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [meAdmin, setMeAdmin] = useState<{ name: string; role: string } | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // assignment table
  const [leads, setLeads] = useState<Lead[]>([]);
  const [marketF, setMarketF] = useState("");
  const [ownerF, setOwnerF] = useState("unassigned");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState<number | null>(null);

  const loadAll = useCallback(async () => {
    const [sdrRes, adminRes, leadRes] = await Promise.all([
      fetch("/api/sdrs"), fetch("/api/admins"), fetch("/api/outbound?all=1"),
    ]);
    if (sdrRes.ok) {
      const d = await sdrRes.json();
      setSdrs(d.sdrs || []);
      setLogins(d.logins || []);
    }
    if (adminRes.ok) {
      const d = await adminRes.json();
      setAdmins(d.admins || []);
      setMeAdmin(d.me || null);
    }
    if (leadRes.ok) setLeads(((await leadRes.json()).rows || []) as Lead[]);
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  const adminAct = async (payload: Record<string, unknown>, method = "POST") => {
    setBusy(true); setMsg("");
    const res = await fetch("/api/admins", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    setBusy(false);
    setMsg(res.ok ? (data.sent ? `✅ Key emailed to ${data.to}` : data.name ? `✅ Identified as ${data.name} (${data.role})` : "✅ Done") : `❌ ${data.error || "failed"}`);
    if (res.ok) { setAdminKey(""); loadAll(); }
  };

  const invite = async () => {
    setBusy(true); setMsg("");
    const res = await fetch("/api/sdrs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setMsg(`❌ ${data.error || "invite failed"}`); return; }
    setMsg(`✅ Invite emailed to ${data.email}`);
    setName(""); setEmail("");
    loadAll();
  };

  const sdrAct = async (id: number, action: string) => {
    setBusy(true); setMsg("");
    const res = await fetch("/api/sdrs", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    const data = await res.json();
    setBusy(false);
    setMsg(res.ok ? "✅ Done" : `❌ ${data.error || "failed"}`);
    loadAll();
  };

  const assign = async (id: number, who: string) => {
    setSaving(id);
    const res = await fetch("/api/outbound", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, fields: { sdr: who } }),
    });
    if (res.ok) setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, sdr: who } : l)));
    setSaving(null);
  };

  const activeSdrNames = useMemo(() => sdrs.filter((s) => s.active).map((s) => s.name), [sdrs]);
  const targets = useMemo(() => ["Ajay", ...activeSdrNames], [activeSdrNames]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leads
      .filter((l) => !marketF || (l.market || "us") === marketF)
      .filter((l) => {
        if (!ownerF) return true;
        if (ownerF === "unassigned") return !l.sdr;
        return l.sdr === ownerF;
      })
      .filter((l) => !needle || `${l.company} ${l.first_name} ${l.last_name} ${l.trigger_detail}`.toLowerCase().includes(needle))
      .slice(0, 400);
  }, [leads, marketF, ownerF, q]);

  return (
    <div className="min-h-screen bg-slate-50 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(124,58,237,0.08),transparent)] text-slate-800">
      <div className="mx-auto max-w-6xl p-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">👥 Team</h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
              access · lead allocation across all agents · login audit
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/outbound" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400">← Outbound</a>
            <a href="/" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-400">Dashboard</a>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* ---- Access: admins + SDRs ---- */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-[11px] font-semibold uppercase tracking-widest text-slate-500">Admins</h2>
              {meAdmin
                ? <span className="text-[11px] font-semibold text-emerald-600">you are {meAdmin.name} ({meAdmin.role})</span>
                : <span className="flex items-center gap-1">
                    <input value={adminKey} onChange={(e) => setAdminKey(e.target.value)} placeholder="adm-… key"
                      className="w-36 rounded border border-slate-300 px-2 py-0.5 font-mono text-[11px]" />
                    <button onClick={() => adminAct({ action: "identify", key: adminKey })} disabled={busy || !adminKey}
                      className="rounded bg-slate-700 px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50">Identify</button>
                  </span>}
            </div>
            <div className="mt-2 space-y-1.5">
              {admins.map((a) => (
                <div key={a.id} className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 ${a.active ? "border-slate-200" : "border-slate-100 opacity-60"}`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800">
                      {a.name}
                      <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${a.role === "super" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>
                        {a.role === "super" ? "★ super admin" : "admin"}
                      </span>
                      {!a.active && <span className="ml-1 text-[10px] font-normal text-slate-400">deactivated</span>}
                    </p>
                    <p className="truncate text-xs text-slate-400">{a.email}{!a.has_key && " · no key issued yet"}</p>
                  </div>
                  <button onClick={() => adminAct({ action: "send_key", id: a.id })} disabled={busy}
                    className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:border-slate-400">
                    {a.has_key ? "↻ Re-key" : "✉ Email key"}
                  </button>
                  {meAdmin?.role === "super" && a.role !== "super" && (a.active
                    ? <button onClick={() => adminAct({ id: a.id, action: "deactivate" }, "PATCH")} disabled={busy}
                        className="rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-500">Deactivate</button>
                    : <button onClick={() => adminAct({ id: a.id, action: "activate" }, "PATCH")} disabled={busy}
                        className="rounded-md border border-emerald-300 px-2 py-1 text-[11px] text-emerald-600">Reactivate</button>)}
                </div>
              ))}
            </div>

            <h2 className="mt-5 font-mono text-[11px] font-semibold uppercase tracking-widest text-slate-500">SDRs</h2>
            <p className="mt-1 text-xs text-slate-500">
              Invite by email only. SDRs sign in at /calls with a one-time emailed code; they see only
              their assigned leads&apos; contact surface — never scores, reasons, or the agents.
            </p>
            <div className="mt-3 flex gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
                className="w-32 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@…"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
              <button onClick={invite} disabled={busy || !name || !email}
                className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
                {busy ? "…" : "Invite"}
              </button>
            </div>
            {msg && <p className="mt-2 text-xs text-slate-600">{msg}</p>}
            <div className="mt-3 max-h-56 space-y-1.5 overflow-y-auto">
              {sdrs.length === 0 && <p className="py-3 text-center text-xs text-slate-400">No SDRs yet — invite the first one above.</p>}
              {sdrs.map((s) => (
                <div key={s.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${s.active ? "border-slate-200" : "border-slate-100 bg-slate-50 opacity-60"}`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800">{s.name}{!s.active && <span className="ml-2 text-[10px] font-normal text-slate-400">deactivated</span>}</p>
                    <p className="truncate text-xs text-slate-400">{s.email}</p>
                  </div>
                  <button onClick={() => sdrAct(s.id, "regenerate")} disabled={busy}
                    className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:border-slate-400">↻ Resend invite</button>
                  {s.active
                    ? <button onClick={() => sdrAct(s.id, "deactivate")} disabled={busy}
                        className="rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-500">Deactivate</button>
                    : <button onClick={() => sdrAct(s.id, "activate")} disabled={busy}
                        className="rounded-md border border-emerald-300 px-2 py-1 text-[11px] text-emerald-600">Reactivate</button>}
                </div>
              ))}
            </div>
          </section>

          {/* ---- Login audit ---- */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-widest text-slate-500">SDR login audit</h2>
            <p className="mt-1 text-xs text-slate-500">
              Every call-desk login with IP + location. New locations and shared-access patterns also
              alert Ajay &amp; Kartheek by email automatically.
            </p>
            <div className="mt-3 max-h-[420px] overflow-y-auto">
              {logins.length === 0 && <p className="py-6 text-center text-xs text-slate-400">No logins yet.</p>}
              <table className="w-full text-xs">
                <tbody>
                  {logins.map((l, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-1.5 pr-2 font-semibold text-slate-700">{l.sdr}</td>
                      <td className="py-1.5 pr-2 font-mono text-slate-500">{l.ip}</td>
                      <td className="py-1.5 pr-2 text-slate-600">{[l.city, l.country].filter(Boolean).join(", ") || "—"}</td>
                      <td className="py-1.5 text-right text-slate-400">{l.created_at} UTC</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* ---- Allocation across ALL agents ---- */}
        <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-slate-500">Lead allocation · all agents</h2>
            <select value={marketF} onChange={(e) => setMarketF(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm">
              <option value="">All agents</option>
              {Object.entries(MARKET_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={ownerF} onChange={(e) => setOwnerF(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm">
              <option value="unassigned">Unassigned</option>
              <option value="">All owners</option>
              {targets.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="⌕ company, contact…"
              className="w-52 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm" />
            <span className="ml-auto text-xs text-slate-500">{visible.length} lead(s)</span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-2 py-2">Agent</th>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Company</th>
                  <th className="px-2 py-2">Contact</th>
                  <th className="px-2 py-2">Trigger / role</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Owner</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100 hover:bg-violet-50/30">
                    <td className="px-2 py-2">
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${MARKET_BADGE[l.market || "us"] ?? MARKET_BADGE.us}`}>
                        {MARKET_LABELS[l.market || "us"] ?? l.market}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-500">{l.queued_date}</td>
                    <td className="max-w-[180px] truncate px-2 py-2 font-medium text-slate-800">{l.company}</td>
                    <td className="max-w-[160px] truncate px-2 py-2 text-slate-600">
                      {l.first_name ? `${l.first_name} ${l.last_name ?? ""}` : <span className="text-slate-300">—</span>}
                      {l.title && <span className="block truncate text-[10px] text-slate-400">{l.title}</span>}
                    </td>
                    <td className="max-w-[260px] truncate px-2 py-2 text-xs text-slate-500" title={l.trigger_detail ?? ""}>
                      {(l.trigger_detail || l.trigger_type || "").slice(0, 80)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-500">{l.status}</td>
                    <td className="px-2 py-2">
                      <select value={l.sdr ?? ""} onChange={(e) => assign(l.id, e.target.value)} disabled={saving === l.id}
                        className={`rounded-md border-0 px-2 py-1 text-xs font-semibold ${l.sdr ? "bg-sky-100 text-sky-700" : "bg-red-50 text-red-500"}`}>
                        <option value="">— assign —</option>
                        {targets.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
