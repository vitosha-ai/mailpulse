import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/senders/history?email=x — 30-day score + warmup trend for one sender.
export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email");
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  const db = getDb();
  const history = db
    .prepare(
      "SELECT date, combined_score, warmup_score, bounce_rate, health_status FROM score_history WHERE email = ? AND date >= date('now', '-30 days') ORDER BY date",
    )
    .all(email);
  const warmup = db
    .prepare(
      "SELECT date, sent, landed_inbox, landed_spam FROM warmup_daily WHERE email = ? AND date >= date('now', '-30 days') ORDER BY date",
    )
    .all(email);
  return NextResponse.json({ history, warmup });
}
