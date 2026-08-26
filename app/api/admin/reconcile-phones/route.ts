import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { extractPhonesByPersonId } from "@/lib/phoneReveal";

// One-time-use (but safe to re-run) recovery: re-scan every raw payload ever
// received by /api/phone-webhook and backfill phone_lookup + research_queue
// from it. Exists because the webhook/ingest race (fixed 2026-08-26) dropped
// numbers that had already arrived before their row existed — this recovers
// them at zero additional Apollo cost, using only data already on disk.
// Same bearer-token auth as /api/outbound/ingest.

export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const payloads = db.prepare("SELECT payload FROM phone_reveals").all() as { payload: string }[];

  const lookupStmt = db.prepare(
    `INSERT INTO phone_lookup (person_id, phone) VALUES (?, ?)
     ON CONFLICT(person_id) DO UPDATE SET phone = excluded.phone`,
  );

  let payloadsParsed = 0;
  let pairsUpserted = 0;
  const reconcile = db.transaction(() => {
    for (const { payload } of payloads) {
      try {
        const phones = extractPhonesByPersonId(JSON.parse(payload));
        payloadsParsed++;
        for (const [personId, phone] of phones) {
          lookupStmt.run(personId, phone);
          pairsUpserted++;
        }
      } catch {
        // unparseable payload — skip
      }
    }
  });
  reconcile();

  const backfillStmt = db.prepare(
    `UPDATE research_queue SET direct_phone = (
       SELECT phone FROM phone_lookup WHERE phone_lookup.person_id = research_queue.apollo_person_id
     )
     WHERE COALESCE(direct_phone, '') = ''
       AND COALESCE(apollo_person_id, '') != ''
       AND EXISTS (SELECT 1 FROM phone_lookup WHERE phone_lookup.person_id = research_queue.apollo_person_id)`,
  );
  const rowsBackfilled = backfillStmt.run().changes;

  return NextResponse.json({
    ok: true,
    payloadsScanned: payloads.length,
    payloadsParsed,
    pairsUpserted,
    rowsBackfilled,
  });
}
