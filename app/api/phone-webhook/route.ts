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

// Walk Apollo's webhook payload (shape varies) and collect {email -> phone}.
function extractPhones(node: unknown, out: Map<string, string>, ctxEmail?: string): void {
  if (Array.isArray(node)) {
    for (const item of node) extractPhones(item, out, ctxEmail);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const email = typeof o.email === "string" && o.email.includes("@") ? o.email.toLowerCase() : ctxEmail;
  const candidates: string[] = [];
  for (const key of ["sanitized_number", "sanitized_phone", "raw_number", "phone"]) {
    if (typeof o[key] === "string" && (o[key] as string).replace(/\D/g, "").length >= 7) {
      candidates.push(o[key] as string);
    }
  }
  if (email && candidates.length && !out.has(email)) out.set(email, candidates[0]);
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") extractPhones(v, out, email);
  }
}

export async function POST(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  ensure();
  const body = await request.text();
  const db = getDb();
  db.prepare("INSERT INTO phone_reveals (payload) VALUES (?)").run(body.slice(0, 50_000));

  // Late-arriving direct numbers: match by contact email, fill direct_phone on
  // any lead rows still missing one (prime POC layer, owner 2026-08-19).
  let updated = 0;
  try {
    const phones = new Map<string, string>();
    extractPhones(JSON.parse(body), phones);
    const stmt = db.prepare(
      `UPDATE research_queue SET direct_phone = ?
       WHERE lower(verified_email) = ? AND COALESCE(direct_phone,'') = ''`,
    );
    for (const [email, phone] of phones) updated += stmt.run(phone, email).changes;
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
