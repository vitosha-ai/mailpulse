import { NextRequest } from "next/server";
import { CONTACT_SELECT, filterQuery, rest, vaultConfigured } from "@/lib/vault";

// GET /api/vault/export?<same filters as /api/vault> — the filtered slice as a
// CSV download (up to 50,000 rows), for handing a list to Smartlead.
const COLS = [
  "email", "first_name", "last_name", "title", "company", "domain", "phone", "linkedin_url",
  "city", "state", "country", "industry", "employees", "email_status", "first_source", "first_campaign", "first_seen",
];
const MAX = 50_000;

function cell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  if (!vaultConfigured()) return new Response("Contact Vault not configured", { status: 503 });
  const sp = request.nextUrl.searchParams;
  const filters = filterQuery({
    q: sp.get("q") || undefined,
    title: sp.get("title") || undefined,
    company: sp.get("company") || undefined,
    domain: sp.get("domain") || undefined,
    country: sp.get("country") || undefined,
    state: sp.get("state") || undefined,
    source: sp.get("source") || undefined,
    campaign: sp.get("campaign") || undefined,
    email_status: sp.get("email_status") || undefined,
    has_phone: sp.get("has_phone") === "1",
    has_email: sp.get("has_email") === "1",
  });
  const lines = [COLS.join(",")];
  for (let offset = 0; offset < MAX; offset += 1000) {
    const qs = [`select=${CONTACT_SELECT}`, ...filters, "order=id", "limit=1000", `offset=${offset}`].join("&");
    const { data } = await rest<Record<string, unknown>[]>(`contacts?${qs}`);
    for (const r of data) lines.push(COLS.map((c) => cell(r[c])).join(","));
    if (data.length < 1000) break;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="contact-vault-${stamp}.csv"`,
    },
  });
}
