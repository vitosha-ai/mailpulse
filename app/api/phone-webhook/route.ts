import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { extractPhonesByPersonId } from "@/lib/phoneReveal";

// Apollo phone-reveal webhook receiver. Apollo can't send our bearer header,
// so auth = a secret `key` query param (the ingest token). POST stores the
// payload; GET (same key) returns everything received — the runner polls it.

function authed(request: NextRequest): boolean {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  return !!token && request.nextUrl.searchParams.get("key") === token;
}

function ensure() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS phone_reveals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export async function POST(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  ensure();
  const body = await request.text();
  const db = getDb();
  db.prepare("INSERT INTO phone_reveals (payload) VALUES (?)").run(body.slice(0, 50_000));

  // Late-arriving direct numbers: match by Apollo person id (fixed 2026-08-26
  // — the payload has no email to match on), fill direct_phone on any lead
  // rows still missing one (prime POC layer, owner 2026-08-19).
  //
  // Race fix 2026-08-26: agents request the reveal early but only publish
  // rows to MailPulse in one batch at the end of the run, so this webhook
  // often arrives before the row exists — the UPDATE below then matches
  // nothing and the number is lost. Every {person_id: phone} pair is also
  // upserted into the durable phone_lookup table so /api/outbound/ingest
  // can backfill it at row-insert time regardless of arrival order.
  let updated = 0;
  try {
    const phones = extractPhonesByPersonId(JSON.parse(body));
    const updateStmt = db.prepare(
      `UPDATE research_queue SET direct_phone = ?
       WHERE apollo_person_id = ? AND COALESCE(direct_phone,'') = ''`,
    );
    const lookupStmt = db.prepare(
      `INSERT INTO phone_lookup (person_id, phone) VALUES (?, ?)
       ON CONFLICT(person_id) DO UPDATE SET phone = excluded.phone`,
    );
    for (const [personId, phone] of phones) {
      updated += updateStmt.run(phone, personId).changes;
      lookupStmt.run(personId, phone);
    }
  } catch {
    // unparseable payload — raw copy is stored above either way
  }
  return NextResponse.json({ ok: true, updated });
}

export async function GET(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  ensure();
  const rows = getDb()
    .prepare("SELECT id, payload, created_at FROM phone_reveals ORDER BY id DESC LIMIT 50")
    .all();
  return NextResponse.json({ reveals: rows });
}
