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

export async function POST(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  ensure();
  const body = await request.text();
  getDb().prepare("INSERT INTO phone_reveals (payload) VALUES (?)").run(body.slice(0, 50_000));
  return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  ensure();
  const rows = getDb()
    .prepare("SELECT id, payload, created_at FROM phone_reveals ORDER BY id DESC LIMIT 50")
    .all();
  return NextResponse.json({ reveals: rows });
}
