import { NextResponse } from "next/server";
import { fullSync } from "@/lib/sync";
import { getDb } from "@/lib/db";

// POST /api/sync — run a full refresh (Instantly + Saleshandy + domains + rescore).
// Long-running by design; the dashboard shows progress from sync_log.
export async function POST() {
  const report = await fullSync();
  return NextResponse.json({ ok: true, report });
}

export async function GET() {
  const rows = getDb()
    .prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT 20")
    .all();
  return NextResponse.json({ log: rows });
}
