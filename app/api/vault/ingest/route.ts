import { NextRequest, NextResponse } from "next/server";
import { upsertContacts, vaultConfigured, VaultError, type ContactIn } from "@/lib/vault";

// POST /api/vault/ingest  { rows: ContactIn[] }  (≤ 1,000 per call)
// Machine-to-machine (bearer OUTBOUND_INGEST_TOKEN; exempt from the password
// gate). Used by the one-time loaders (Apollo backfill, campaign CSVs) and by
// campaign_pull.py after each reveal batch. Idempotent: upsert on email.
export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!vaultConfigured()) return NextResponse.json({ error: "Contact Vault not configured" }, { status: 503 });
  const body = (await request.json()) as { rows?: ContactIn[] };
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
  if (!rows.length) return NextResponse.json({ contacts: 0, sources: 0, skipped: 0 });
  try {
    return NextResponse.json(await upsertContacts(rows));
  } catch (e) {
    const status = e instanceof VaultError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
