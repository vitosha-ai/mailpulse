import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/snapshot — the "8 AM briefing": the few highest-impact things to
// look at, each with a count and a filter to jump straight to them.
export async function GET() {
  const db = getDb();

  const scalar = (sql: string, ...p: unknown[]) =>
    (db.prepare(sql).get(...p) as { n: number }).n;

  // Distinct domains on Spamhaus (the severe blocklist) right now.
  const spamhausDomains = db
    .prepare(`SELECT domain FROM domain_checks WHERE blocklists LIKE '%"list":"spamhaus-dbl","listed":true%'`)
    .all() as { domain: string }[];

  const items = [
    {
      key: "spamhaus",
      severity: "critical",
      label: "Domains on Spamhaus",
      detail: "Directly hurts Microsoft/corporate delivery — pause and delist.",
      count: spamhausDomains.length,
      filter: { blocklisted: "1" },
      names: spamhausDomains.map((d) => d.domain),
    },
    {
      key: "disconnected",
      severity: "critical",
      label: "Disconnected mailboxes",
      detail: "Silently skipped by the sequencer — reconnect them.",
      count:
        scalar("SELECT COUNT(*) n FROM senders WHERE sl_smtp_ok = 0 OR sl_imap_ok = 0") +
        scalar("SELECT COUNT(*) n FROM senders WHERE ti_status IN ('error','auth-expired')"),
      filter: { issue: "disconnected" },
    },
    {
      key: "spam",
      severity: "critical",
      label: "Senders landing in spam",
      detail: "Latest placement test put these in the spam folder.",
      count: scalar(
        `SELECT COUNT(DISTINCT email) n FROM placement_results WHERE (google_verdict='spam' OR microsoft_verdict='spam') AND tested_at >= datetime('now','-14 days')`,
      ),
      filter: { issue: "spam" },
    },
    {
      key: "critical-score",
      severity: "critical",
      label: "Senders scoring below 60",
      detail: "Combined health is critical — rest or pause.",
      count: scalar("SELECT COUNT(*) n FROM senders WHERE combined_score < 60"),
      filter: { score: "low" },
    },
    {
      key: "warmup-spam",
      severity: "warn",
      label: "Warmup drifting to spam",
      detail: "Early warning — warmup mail creeping into spam folders.",
      count: scalar("SELECT COUNT(*) n FROM alerts WHERE rule='warmup-spam' AND resolved_at IS NULL"),
      filter: { status: "yellow" },
    },
    {
      key: "no-dmarc",
      severity: "warn",
      label: "Domains missing DMARC",
      detail: "Quick DNS fix that improves inbox rates.",
      count: scalar("SELECT COUNT(*) n FROM domain_checks WHERE dmarc_ok = 0"),
      filter: { issue: "no-dmarc" },
    },
  ].filter((i) => i.count > 0);

  const lastSync = (db
    .prepare("SELECT finished_at FROM sync_log WHERE kind='full' AND ok=1 ORDER BY id DESC LIMIT 1")
    .get() as { finished_at: string } | undefined)?.finished_at ?? null;

  const counts = db
    .prepare("SELECT health_status, COUNT(*) AS n FROM senders GROUP BY health_status")
    .all() as { health_status: string; n: number }[];

  // Ready reserve: healthy mailboxes connected to a sequencer but not yet
  // assigned to any campaign — capacity available to deploy.
  const idleClause = "(campaigns IS NULL OR campaigns = '[]' OR campaigns = 'null')";
  const reserves = {
    smartlead: scalar(
      `SELECT COUNT(*) n FROM senders WHERE smartlead_id IS NOT NULL AND health_status = 'green' AND ${idleClause}`,
    ),
    saleshandy: scalar(
      `SELECT COUNT(*) n FROM senders WHERE saleshandy_id IS NOT NULL AND health_status = 'green' AND ${idleClause}`,
    ),
  };

  return NextResponse.json({
    generatedAt: lastSync,
    fleet: Object.fromEntries(counts.map((c) => [c.health_status, c.n])),
    items,
    reserves,
  });
}
