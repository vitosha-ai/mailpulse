import { NextRequest, NextResponse } from "next/server";
import { searchContacts, stats, vaultConfigured, VaultError } from "@/lib/vault";

// GET /api/vault — search the Contact Vault (behind the password gate).
//   ?q=&title=&company=&domain=&country=&state=&source=&campaign=&email_status=
//   &has_phone=1&has_email=1&limit=50&offset=0
//   ?stats=1 → totals + by-source + by-country summaries instead of rows.
export async function GET(request: NextRequest) {
  if (!vaultConfigured()) {
    return NextResponse.json({ configured: false, error: "Contact Vault not configured" }, { status: 503 });
  }
  const sp = request.nextUrl.searchParams;
  try {
    if (sp.get("stats") === "1") return NextResponse.json({ configured: true, ...(await stats()) });
    const res = await searchContacts({
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
      limit: Number(sp.get("limit") || 50),
      offset: Number(sp.get("offset") || 0),
    });
    return NextResponse.json({ configured: true, ...res });
  } catch (e) {
    const status = e instanceof VaultError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
