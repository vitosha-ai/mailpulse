import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { upsertContacts, vaultConfigured, VaultError, type ContactIn } from "@/lib/vault";
import { rqToContact, type RQ } from "@/lib/vault-agents";

// POST /api/vault/sync-agents — copy every research-agent lead already in
// MailPulse (research_queue) into the Contact Vault. Behind the password gate
// (a button on the Apollo data page). Idempotent, so it can be re-run any time;
// new nightly rows also flow in automatically from /api/outbound/ingest.
export async function POST() {
  if (!vaultConfigured()) return NextResponse.json({ error: "Contact Vault not configured" }, { status: 503 });
  const rows = getDb()
    .prepare(
      `SELECT first_name, last_name, title, verified_email, linkedin, company, size, market, trigger_type,
              queued_date, direct_phone, phone, apollo_person_id
         FROM research_queue WHERE verified_email LIKE '%@%' ORDER BY queued_date`,
    )
    .all() as RQ[];
  let contacts = 0, sources = 0, skipped = 0;
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500).map(rqToContact).filter((c): c is ContactIn => !!c);
      const r = await upsertContacts(batch);
      contacts += r.contacts; sources += r.sources; skipped += r.skipped;
    }
    return NextResponse.json({ scanned: rows.length, contacts, sources, skipped });
  } catch (e) {
    const status = e instanceof VaultError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message, contacts, sources }, { status });
  }
}
