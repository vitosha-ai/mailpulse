import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSeoConfig, runSeo } from "@/lib/seo";

// /api/seo
// GET  — everything the SEO widget renders: config status, latest rankings
//        with movement vs the previous check, new competitor pages (14 days),
//        and the Search Console 28-day window.
// POST — { force?: boolean } runs the watchdog now (force bypasses the
//        weekly-rankings guard; costs one Serper search per keyword).

export async function GET() {
  const db = getDb();
  const { site, keywords, competitors, serperKey, gscSite } = getSeoConfig();

  // Two most recent check dates → current position + movement.
  const dates = (
    db.prepare("SELECT DISTINCT date FROM seo_rank_history ORDER BY date DESC LIMIT 2").all() as { date: string }[]
  ).map((r) => r.date);
  const [cur, prev] = dates;

  type RankRow = { keyword: string; domain: string; position: number | null; url: string | null };
  const at = (date: string) =>
    db.prepare("SELECT keyword, domain, position, url FROM seo_rank_history WHERE date = ?").all(date) as RankRow[];
  const current = cur ? at(cur) : [];
  const previous = new Map(prev ? at(prev).map((r) => [`${r.keyword}|${r.domain}`, r.position] as const) : []);

  const rankings = current.map((r) => ({
    ...r,
    // positive delta = moved up (smaller position number is better)
    delta:
      r.position != null && previous.get(`${r.keyword}|${r.domain}`) != null
        ? (previous.get(`${r.keyword}|${r.domain}`) as number) - r.position
        : null,
  }));

  const newPages = db
    .prepare(
      `SELECT url, domain, first_seen FROM seo_competitor_pages
        WHERE first_seen >= datetime('now', '-14 days')
        ORDER BY first_seen DESC LIMIT 50`,
    )
    .all();

  const gsc = db
    .prepare("SELECT date, clicks, impressions, ctr, position, top_queries FROM seo_gsc_daily ORDER BY date ASC")
    .all() as { date: string; clicks: number; impressions: number; ctr: number; position: number; top_queries: string | null }[];

  return NextResponse.json({
    config: {
      site,
      keywords,
      competitors,
      serper: Boolean(serperKey),
      gscSite,
      gscReady: gsc.length > 0,
    },
    checkedAt: cur ?? null,
    previousAt: prev ?? null,
    rankings,
    newPages,
    gsc,
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  const report = await runSeo(Boolean(body.force));
  return NextResponse.json({ ok: true, report });
}
