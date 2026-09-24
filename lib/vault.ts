import { getSetting } from "./db";

// Contact Vault: Vitosha's own copy of every person paid for in Apollo, held
// in a Supabase Postgres (schema: supabase/contact_vault.sql). Talked to over
// Supabase's REST layer (PostgREST) with plain fetch — no SDK dependency.
// The service key lives in MailPulse settings (Settings page), server-side only.

export class VaultError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function vaultConfigured(): boolean {
  return !!(getSetting("supabase_url") && getSetting("supabase_service_key"));
}

function cfg() {
  const url = (getSetting("supabase_url") || "").replace(/\/+$/, "");
  const key = getSetting("supabase_service_key") || "";
  if (!url || !key) throw new VaultError(503, "Contact Vault not configured (Settings → Supabase URL + service key).");
  return { url, key };
}

export async function rest<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<{ data: T; count: number | null }> {
  const { url, key } = cfg();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: key,
      // Legacy service_role keys are JWTs and go in Authorization too; the
      // new sb_secret_* keys are not JWTs and are sent as apikey only.
      ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VaultError(
      res.status,
      `Supabase ${init.method ?? "GET"} ${path.split("?")[0]} → ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  const range = res.headers.get("content-range"); // "0-49/1234" or "*/1234"
  const count =
    range && range.includes("/") && range.split("/")[1] !== "*" ? Number(range.split("/")[1]) : null;
  const text = await res.text();
  return { data: (text ? JSON.parse(text) : null) as T, count };
}

// ---- writing ---------------------------------------------------------------

export type ContactIn = {
  email?: string | null;
  email_status?: string | null;
  unsubscribed?: boolean;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  headline?: string | null;
  phone?: string | null;
  phones?: unknown;
  linkedin_url?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  company?: string | null;
  domain?: string | null;
  industry?: string | null;
  employees?: number | null;
  apollo_contact_id?: string | null;
  apollo_person_id?: string | null;
  apollo_org_id?: string | null;
  apollo_stage?: string | null;
  apollo_labels?: unknown;
  apollo_source?: string | null;
  apollo_owner?: string | null;
  apollo_created_at?: string | null;
  // provenance for this delivery
  source: "apollo" | "campaign" | "agent";
  campaign?: string | null;
  acquired_at?: string | null;
  credits_est?: number;
  detail?: string | null;
};

const CONTACT_COLS = new Set([
  "email_status", "unsubscribed", "first_name", "last_name", "title", "headline", "phone", "phones",
  "linkedin_url", "city", "state", "country", "company", "domain", "industry", "employees",
  "apollo_contact_id", "apollo_person_id", "apollo_org_id", "apollo_stage", "apollo_labels", "apollo_source",
  "apollo_owner", "apollo_created_at",
]);

export function keyFor(c: { email?: string | null; apollo_contact_id?: string | null }): string | null {
  const e = (c.email || "").trim().toLowerCase();
  if (e.includes("@")) return e;
  if (c.apollo_contact_id) return `apollo:${c.apollo_contact_id}`;
  return null;
}

// Upsert a batch (≤ 1,000). Only the columns a row actually carries are sent,
// so a campaign row (no phone) never blanks the phone Apollo gave us. Rows are
// grouped by column-set because PostgREST needs uniform keys per request.
export async function upsertContacts(
  rows: ContactIn[],
): Promise<{ contacts: number; sources: number; skipped: number }> {
  type Rec = Record<string, unknown>;
  const groups = new Map<string, Rec[]>();
  const prov: {
    key: string; source: string; campaign: string; acquired_at: string | null; credits_est: number; detail: string | null;
  }[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    const key = keyFor(r);
    if (!key || seen.has(key)) { skipped++; continue; }
    seen.add(key);
    const rec: Rec = {
      key,
      first_source: r.source,
      first_campaign: r.campaign ?? "",
      first_seen: r.acquired_at ?? new Date().toISOString(),
    };
    if (key.includes("@")) rec.email = key;
    for (const [k, v] of Object.entries(r)) {
      if (CONTACT_COLS.has(k) && v !== undefined && v !== null && v !== "") rec[k] = v;
    }
    const sig = Object.keys(rec).sort().join(",");
    let g = groups.get(sig);
    if (!g) { g = []; groups.set(sig, g); }
    g.push(rec);
    prov.push({
      key, source: r.source, campaign: r.campaign ?? "", acquired_at: r.acquired_at ?? null,
      credits_est: r.credits_est ?? 0, detail: r.detail ?? null,
    });
  }
  const ids = new Map<string, number>();
  for (const recs of groups.values()) {
    const { data } = await rest<{ id: number; key: string }[]>("contacts?on_conflict=key&select=id,key", {
      method: "POST",
      body: recs,
      prefer: "resolution=merge-duplicates,return=representation",
    });
    for (const d of data) ids.set(d.key, d.id);
  }
  const srcRows = prov
    .map((p) => ({
      contact_id: ids.get(p.key), source: p.source, campaign: p.campaign,
      acquired_at: p.acquired_at, credits_est: p.credits_est, detail: p.detail,
    }))
    .filter((s) => s.contact_id);
  if (srcRows.length) {
    await rest("contact_sources?on_conflict=contact_id,source,campaign", {
      method: "POST",
      body: srcRows,
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
  return { contacts: ids.size, sources: srcRows.length, skipped };
}

// Which of these emails do we already own? (pulls/agents call this before spending a credit)
export async function knownEmails(emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const keys = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys
      .slice(i, i + 200)
      .map((k) => `"${k.replace(/["()]/g, "")}"`)
      .join(",");
    const { data } = await rest<{ key: string }[]>(`contacts?select=key&key=in.(${encodeURIComponent(chunk)})`);
    for (const d of data) out.add(d.key);
  }
  return out;
}

// Same, by Apollo person id — the one thing a redacted Apollo search result
// does carry, so a pull can skip a person BEFORE paying to reveal them.
export async function knownPersonIds(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const clean = [...new Set(ids.filter((i) => /^[a-f0-9]{24}$/.test(i)))];
  for (let i = 0; i < clean.length; i += 300) {
    const chunk = clean.slice(i, i + 300).join(",");
    const { data } = await rest<{ apollo_person_id: string }[]>(
      `contacts?select=apollo_person_id&apollo_person_id=in.(${chunk})`,
    );
    for (const d of data) out.add(d.apollo_person_id);
  }
  return out;
}

// ---- reading ---------------------------------------------------------------

export type SearchParams = {
  q?: string; title?: string; company?: string; domain?: string; country?: string; state?: string;
  source?: string; campaign?: string; email_status?: string; has_phone?: boolean; has_email?: boolean;
  limit?: number; offset?: number;
};

export const CONTACT_SELECT =
  "id,email,email_status,unsubscribed,first_name,last_name,title,phone,linkedin_url,city,state,country,company,domain,industry,employees,first_source,first_campaign,first_seen,apollo_source,apollo_created_at";

// Strip the characters PostgREST treats as filter syntax before interpolating.
function esc(v: string) {
  return encodeURIComponent(v.replace(/[,.()"\\*]/g, " ").trim());
}

export function filterQuery(p: SearchParams): string[] {
  const f: string[] = [];
  if (p.q) {
    const s = esc(p.q);
    f.push(`or=(first_name.ilike.*${s}*,last_name.ilike.*${s}*,email.ilike.*${s}*,company.ilike.*${s}*)`);
  }
  if (p.title) f.push(`title=ilike.*${esc(p.title)}*`);
  if (p.company) f.push(`company=ilike.*${esc(p.company)}*`);
  if (p.domain) f.push(`domain=ilike.*${esc(p.domain)}*`);
  if (p.country) f.push(`country=eq.${encodeURIComponent(p.country)}`);
  if (p.state) f.push(`state=eq.${encodeURIComponent(p.state)}`);
  if (p.source) f.push(`first_source=eq.${encodeURIComponent(p.source)}`);
  if (p.campaign) f.push(`first_campaign=ilike.*${esc(p.campaign)}*`);
  if (p.email_status) f.push(`email_status=eq.${encodeURIComponent(p.email_status)}`);
  if (p.has_phone) f.push("phone=not.is.null");
  if (p.has_email) f.push("email=not.is.null");
  return f;
}

export async function searchContacts(p: SearchParams) {
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 1000);
  const offset = Math.max(p.offset ?? 0, 0);
  const qs = [
    `select=${CONTACT_SELECT}`,
    ...filterQuery(p),
    "order=first_seen.desc.nullslast,id.desc",
    `limit=${limit}`,
    `offset=${offset}`,
  ].join("&");
  const { data, count } = await rest<Record<string, unknown>[]>(`contacts?${qs}`, { prefer: "count=estimated" });
  return { rows: data, total: count, limit, offset };
}

export async function stats() {
  const [s, bySource, byCountry] = await Promise.all([
    rest<Record<string, number>[]>("vault_stats?select=*"),
    rest<Record<string, unknown>[]>("vault_by_source?select=*"),
    rest<{ country: string; n: number }[]>("vault_by_country?select=*&limit=12"),
  ]);
  return { totals: s.data[0] ?? null, by_source: bySource.data, by_country: byCountry.data };
}
