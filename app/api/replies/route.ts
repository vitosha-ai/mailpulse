import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/replies — the classified reply feed for the Replies page.
// PATCH /api/replies — update a row's status (New | Worked | Ignored).
// Both behind the browser password gate (proxy.ts covers them automatically).

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const limit = Math.min(1000, Math.max(1, Number(sp.get("limit")) || 500));
  const rows = getDb()
    .prepare(
      `SELECT id, replied_at, campaign_name, lead_email, lead_name, company,
              category, return_date, alt_contact_name, alt_contact_email,
              summary, snippet, status
       FROM reply_intel ORDER BY replied_at DESC LIMIT ?`,
    )
    .all(limit);
  return NextResponse.json({ rows });
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json()) as { id?: number; status?: string };
  if (!body.id || !["New", "Worked", "Ignored"].includes(body.status ?? "")) {
    return NextResponse.json({ error: "id and valid status required" }, { status: 400 });
  }
  const res = getDb()
    .prepare("UPDATE reply_intel SET status = ? WHERE id = ?")
    .run(body.status, body.id);
  return NextResponse.json({ updated: res.changes });
}
