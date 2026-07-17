import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/outbound/costs — agent spend aggregated over standard windows.
// Source: agent_usage (one row per run, written via /api/outbound/ingest).

type Agg = {
  runs: number;
  apollo_credits: number;
  apollo_cost_usd: number;
  anthropic_tokens: number;
  anthropic_cost_usd: number;
  apify_runs: number;
  apify_cost_usd: number;
  brightdata_records: number;
  brightdata_cost_usd: number;
  total_cost_usd: number;
};

function aggregate(sinceIso: string | null): Agg {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(apollo_credits), 0) AS apollo_credits,
              COALESCE(SUM(apollo_cost_usd), 0) AS apollo_cost_usd,
              COALESCE(SUM(anthropic_input_tokens + anthropic_output_tokens), 0) AS anthropic_tokens,
              COALESCE(SUM(anthropic_cost_usd), 0) AS anthropic_cost_usd,
              COALESCE(SUM(apify_runs), 0) AS apify_runs,
              COALESCE(SUM(apify_cost_usd), 0) AS apify_cost_usd,
              COALESCE(SUM(brightdata_records), 0) AS brightdata_records,
              COALESCE(SUM(brightdata_cost_usd), 0) AS brightdata_cost_usd,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
       FROM agent_usage ${sinceIso ? "WHERE run_date >= ?" : ""}`,
    )
    .get(...(sinceIso ? [sinceIso] : [])) as Agg;
  return row;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);

  // Daily series for the last 30 days (for the mini history list).
  const daily = getDb()
    .prepare(
      `SELECT run_date,
              SUM(apollo_credits) AS apollo_credits,
              SUM(apollo_cost_usd) AS apollo_cost_usd,
              SUM(anthropic_cost_usd) AS anthropic_cost_usd,
              SUM(total_cost_usd) AS total_cost_usd,
              COUNT(*) AS runs
       FROM agent_usage
       WHERE run_date >= ?
       GROUP BY run_date
       ORDER BY run_date DESC`,
    )
    .all(daysAgo(30)) as Record<string, number | string>[];

  return NextResponse.json({
    today: aggregate(today),
    week: aggregate(daysAgo(6)),   // rolling 7 days incl. today
    month: aggregate(daysAgo(29)), // rolling 30 days incl. today
    allTime: aggregate(null),
    daily,
  });
}
