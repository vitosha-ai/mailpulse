import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/outbound/learning — the learning-log feed, newest first.
// Params: market (us|gcc|…; omit for all), limit (default 50).
// Behind the browser password gate like the rest of the app.
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const market = sp.get("market");
  const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));

  const where = market ? "WHERE market = ?" : "";
  const params: unknown[] = market ? [market, limit] : [limit];
  const entries = getDb()
    .prepare(
      `SELECT id, date, market, kind, entry FROM learning_log
       ${where} ORDER BY date DESC, id DESC LIMIT ?`,
    )
    .all(...params);
  return NextResponse.json({ entries });
}

// POST /api/outbound/learning — append a LEARNED entry (a user-approved
// lesson from a review session). Machine-to-machine: same bearer token as
// /api/outbound/ingest, exempted from the password gate via proxy.ts only
// if that path is listed there — otherwise call it through the gate.
export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json()) as {
    date?: string;
    market?: string;
    kind?: string;
    entry?: string;
  };
  const entry = (body.entry || "").trim();
  if (!entry) return NextResponse.json({ error: "entry required" }, { status: 400 });
  getDb()
    .prepare("INSERT INTO learning_log (date, market, kind, entry) VALUES (?, ?, ?, ?)")
    .run(
      body.date || new Date().toISOString().slice(0, 10),
      body.market || "us",
      body.kind === "auto" ? "auto" : "learned",
      entry.slice(0, 2000),
    );
  return NextResponse.json({ ok: true });
}
