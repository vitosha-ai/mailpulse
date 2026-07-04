import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  const alerts = getDb()
    .prepare("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, id DESC")
    .all();
  return NextResponse.json({ alerts });
}

// POST { id } — mark an alert resolved.
export async function POST(request: NextRequest) {
  const { id } = (await request.json()) as { id: number };
  getDb().prepare("UPDATE alerts SET resolved_at = datetime('now') WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
