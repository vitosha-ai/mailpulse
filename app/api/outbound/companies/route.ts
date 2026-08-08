import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/outbound/companies?days=30 — machine-to-machine: company names the
// B2B research agents queued recently (market != staffing). The staffing agent
// calls this before delivering leads so an SDR never cold-calls a buyer the
// email campaigns touched the same month without knowing (collision flag, not
// a drop). Bearer-token protected like the ingest route; exempted in proxy.ts.

export async function GET(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const days = Math.min(365, Math.max(1, Number(request.nextUrl.searchParams.get("days")) || 30));
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const rows = getDb()
    .prepare(
      `SELECT DISTINCT company, market, MAX(queued_date) AS last_queued
       FROM research_queue
       WHERE queued_date >= ? AND COALESCE(market, 'us') != 'staffing' AND company != ''
       GROUP BY company, market`,
    )
    .all(cutoff) as { company: string; market: string; last_queued: string }[];

  return NextResponse.json({ companies: rows });
}
