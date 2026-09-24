import { NextRequest, NextResponse } from "next/server";
import { knownEmails, knownPersonIds, vaultConfigured, VaultError } from "@/lib/vault";

// POST /api/vault/check  { emails?: [...], person_ids?: [...] }  → { known: [...], known_ids: [...] }
// Machine-to-machine (bearer OUTBOUND_INGEST_TOKEN; exempt from the password
// gate in proxy.ts). Campaign pulls and the agents ask this BEFORE revealing a
// person in Apollo, so a credit is never spent twice on the same email.
export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!vaultConfigured()) return NextResponse.json({ error: "Contact Vault not configured" }, { status: 503 });
  const body = (await request.json()) as { emails?: string[]; person_ids?: string[] };
  const emails = Array.isArray(body.emails) ? body.emails.filter((e) => typeof e === "string").slice(0, 5000) : [];
  const ids = Array.isArray(body.person_ids) ? body.person_ids.filter((e) => typeof e === "string").slice(0, 5000) : [];
  try {
    const [known, knownIds] = await Promise.all([knownEmails(emails), knownPersonIds(ids)]);
    return NextResponse.json({ known: [...known], known_ids: [...knownIds] });
  } catch (e) {
    const status = e instanceof VaultError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
