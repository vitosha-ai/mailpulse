import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Admin cleanup (owner 2026-10-26): purge senders whose mailboxes were
// permanently deleted at the provider (the 136 free Maildoso boxes removed
// Oct 24-26). Deletes their sender rows and resolves any open alerts that
// target those emails — or their domains, when no other sender remains on
// the domain. Same bearer-token auth as the other machine endpoints.
// POST body: { emails: string[], dry_run?: boolean }

export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { emails?: string[]; dry_run?: boolean };
  const emails = (body.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (emails.length === 0 || emails.length > 500) {
    return NextResponse.json({ error: "emails: 1-500 required" }, { status: 400 });
  }
  const dryRun = body.dry_run !== false; // default dry-run; pass false to apply

  const db = getDb();
  const found = emails.filter(
    (e) => db.prepare("SELECT 1 FROM senders WHERE lower(email) = ?").get(e),
  );
  const domains = [...new Set(found.map((e) => e.split("@")[1]))];

  const openSenderAlerts = db
    .prepare(
      `SELECT COUNT(*) AS n FROM alerts
       WHERE resolved_at IS NULL AND target_type = 'sender'
         AND lower(target) IN (${found.map(() => "?").join(",") || "''"})`,
    )
    .get(...found) as { n: number };

  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      requested: emails.length,
      found_in_senders: found.length,
      open_sender_alerts: openSenderAlerts.n,
      domains_touched: domains.length,
    });
  }

  let sendersDeleted = 0;
  let alertsResolved = 0;
  let domainAlertsResolved = 0;
  const tx = db.transaction(() => {
    for (const e of found) {
      sendersDeleted += db.prepare("DELETE FROM senders WHERE lower(email) = ?").run(e).changes;
      alertsResolved += db
        .prepare(
          `UPDATE alerts SET resolved_at = datetime('now')
           WHERE resolved_at IS NULL AND target_type = 'sender' AND lower(target) = ?`,
        )
        .run(e).changes;
    }
    // Domain-level alerts: resolve only when the domain has no senders left.
    for (const d of domains) {
      const remaining = db
        .prepare("SELECT COUNT(*) AS n FROM senders WHERE lower(email) LIKE ?")
        .get(`%@${d}`) as { n: number };
      if (remaining.n === 0) {
        domainAlertsResolved += db
          .prepare(
            `UPDATE alerts SET resolved_at = datetime('now')
             WHERE resolved_at IS NULL AND target_type = 'domain' AND lower(target) = ?`,
          )
          .run(d).changes;
      }
    }
  });
  tx();

  return NextResponse.json({
    dry_run: false,
    senders_deleted: sendersDeleted,
    sender_alerts_resolved: alertsResolved,
    domain_alerts_resolved: domainAlertsResolved,
  });
}
