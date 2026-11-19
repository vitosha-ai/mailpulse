import { NextRequest, NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import { emailDigest, listOpen, processEmail, runSled, sledConfig, sledStats, storeEmail, updateOpp } from "@/lib/sled";

// /api/sled — US State & Local (SLED) RFP agent (BidPrime alert emails).
// GET   — open opportunities + config. ?drops=1 also returns rows the filter dropped.
//         ?stats=1 returns only the tile counts.
// POST  — { action: "run" }               read the mailbox now (no email)
//         { action: "backfill", days? }    one-time re-read of older alert emails (default 60 days)
//         { action: "email", to? }        email everything open now (test send)
//         { action: "settings", emailTo } save the daily recipient list
//         { action: "import", subject, html } feed one alert email by hand (testing)
// PATCH — { id, status?, notes? }         team triage on one opportunity

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  if (sp.get("stats") === "1") return NextResponse.json(sledStats());
  return NextResponse.json({ rows: listOpen({ includeDrops: sp.get("drops") === "1" }), config: sledConfig() });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string; to?: string; emailTo?: string; subject?: string; html?: string;
  };
  try {
    if (body.action === "run") {
      const report = await runSled();
      return NextResponse.json({ ok: true, report: { ...report, newIds: report.newIds.length } });
    }
    if (body.action === "backfill") {
      // One-time catch-up: re-read older BidPrime alert emails (default 60 days, max 120).
      const days = Math.min(120, Math.max(1, Number((body as { days?: number }).days) || 60));
      const report = await runSled({ backfillDays: days });
      return NextResponse.json({ ok: true, report: { ...report, newIds: report.newIds.length } });
    }
    // The real digest, sent now: only bids never emailed before, then marked sent
    // (so the next morning's digest won't repeat them).
    if (body.action === "digest") return NextResponse.json({ ok: true, result: await emailDigest(true) });
    if (body.action === "email") return NextResponse.json({ ok: true, result: await emailDigest(false, body.to) });
    if (body.action === "settings") {
      setSetting("sled_email_to", (body.emailTo || "").trim());
      return NextResponse.json({ ok: true, config: sledConfig() });
    }
    if (body.action === "import") {
      if (!body.html) return NextResponse.json({ error: "html required" }, { status: 400 });
      const key = `manual-${Date.now()}`;
      storeEmail(key, new Date().toISOString(), body.subject || "BidPrime alert", body.html, null);
      const report = await processEmail(key);
      return NextResponse.json({ ok: true, report: { ...report, newIds: report.newIds.length } });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { id?: string; status?: string; notes?: string };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    updateOpp(body.id, { status: body.status, notes: body.notes });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
