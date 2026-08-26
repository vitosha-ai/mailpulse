import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

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

// Apollo's phone-reveal webhook payload is keyed by its internal person id —
// it never carries an email (verified live, 2026-08-26: 50/50 payloads had
// `people[].id` + `phone_numbers[]`, zero had an email field anywhere). The
// ORIGINAL email-matching design silently dropped every successful reveal.
// Shape: { people: [ { id, phone_numbers: [{ sanitized_number, type_cd,
// status_cd, confidence_cd }] } ] } — prefer a valid mobile number, else the
// first valid number, else the first number present.
function extractPhonesByPersonId(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const people = (payload as { people?: unknown[] })?.people;
  if (!Array.isArray(people)) return out;
  for (const person of people) {
    if (!person || typeof person !== "object") continue;
    const p = person as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : null;
    const numbers = Array.isArray(p.phone_numbers) ? (p.phone_numbers as Record<string, unknown>[]) : [];
    if (!id || numbers.length === 0) continue;
    const pick =
      numbers.find((n) => n.type_cd === "mobile" && n.status_cd === "valid_number") ??
      numbers.find((n) => n.status_cd === "valid_number") ??
      numbers[0];
    const num = typeof pick.sanitized_number === "string" ? pick.sanitized_number
              : typeof pick.raw_number === "string" ? pick.raw_number : null;
    if (num) out.set(id, num);
  }
  return out;
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
  let updated = 0;
  try {
    const phones = extractPhonesByPersonId(JSON.parse(body));
    const stmt = db.prepare(
      `UPDATE research_queue SET direct_phone = ?
       WHERE apollo_person_id = ? AND COALESCE(direct_phone,'') = ''`,
    );
    for (const [personId, phone] of phones) updated += stmt.run(phone, personId).changes;
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
