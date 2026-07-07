import { Resolver } from "node:dns/promises";
import { getDb } from "./db";
import { createPlacementTest, getPlacementTest, listPlacementRecords } from "./instantly";

// Placement test orchestration. Senders are tested in batches, and results
// are parsed from Instantly's per-judgment records (live-verified shape).

// Domain reputation dominates placement (DKIM/blocklists/filter history are
// per-domain), so coverage beats redundancy: pick at most ONE mailbox per
// domain per batch — the least-recently-tested mailbox of the
// least-recently-tested domain — and only top up with same-domain repeats
// when there are fewer untested domains than batch slots.
export function pickSendersForTest(batchSize: number): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT email FROM (
         SELECT s.email, s.domain,
                (SELECT MAX(tested_at) FROM placement_results pr WHERE pr.email = s.email) AS mailbox_tested,
                (SELECT MAX(tested_at) FROM placement_results pr
                   JOIN senders s2 ON s2.email = pr.email
                  WHERE s2.domain = s.domain) AS domain_tested,
                ROW_NUMBER() OVER (
                  PARTITION BY s.domain
                  ORDER BY (SELECT MAX(tested_at) FROM placement_results pr WHERE pr.email = s.email) ASC NULLS FIRST,
                           s.email
                ) AS rank_in_domain
         FROM senders s
         WHERE s.instantly_status = 1
       )
       ORDER BY rank_in_domain ASC,
                domain_tested IS NOT NULL, domain_tested ASC,
                mailbox_tested IS NOT NULL, mailbox_tested ASC
       LIMIT ?`,
    )
    .all(batchSize) as { email: string }[];
  return rows.map((r) => r.email);
}

export async function startPlacementBatch(emails: string[]): Promise<number> {
  const db = getDb();
  const name = `mailpulse-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  const created = await createPlacementTest(name, emails);
  const info = db
    .prepare("INSERT INTO placement_tests (instantly_test_id, name, status, emails) VALUES (?, ?, 'running', ?)")
    .run(String(created.id), name, JSON.stringify(emails));
  return Number(info.lastInsertRowid);
}

// Seed inboxes live on arbitrary domains; classify each seed's provider by
// its MX records (cached per domain).
const mxResolver = new Resolver();
mxResolver.setServers(["8.8.8.8", "1.1.1.1"]);
const seedProviderCache = new Map<string, "google" | "microsoft" | "other">();

async function seedProvider(email: string): Promise<"google" | "microsoft" | "other"> {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const cached = seedProviderCache.get(domain);
  if (cached) return cached;
  let result: "google" | "microsoft" | "other" = "other";
  try {
    const mx = (await mxResolver.resolveMx(domain)).map((m) => m.exchange).join(" ").toLowerCase();
    if (mx.includes("google")) result = "google";
    else if (mx.includes("outlook") || mx.includes("microsoft")) result = "microsoft";
  } catch {
    // leave as other
  }
  seedProviderCache.set(domain, result);
  return result;
}

// Poll running tests; when a test leaves status 1 (running), pull its
// judgment records and store per-sender verdicts.
export async function pollPlacementTests(): Promise<string> {
  const db = getDb();
  const running = db
    .prepare("SELECT id, instantly_test_id FROM placement_tests WHERE status = 'running'")
    .all() as { id: number; instantly_test_id: string }[];
  if (running.length === 0) return "no running placement tests";

  let completed = 0;
  for (const t of running) {
    try {
      const test = await getPlacementTest(t.instantly_test_id);
      const status = Number((test as { status?: unknown }).status ?? 1);
      if (status === 1) continue; // still running

      const records = await listPlacementRecords(t.instantly_test_id);
      const insert = db.prepare(`
        INSERT INTO placement_results (email, test_id, tested_at, google_verdict, microsoft_verdict, inbox_rate)
        VALUES (?, ?, datetime('now'), ?, ?, ?)
        ON CONFLICT(email, test_id) DO UPDATE SET
          google_verdict = excluded.google_verdict,
          microsoft_verdict = excluded.microsoft_verdict,
          inbox_rate = excluded.inbox_rate
      `);

      type Agg = { inbox: number; spam: number; google: string | null; microsoft: string | null };
      const bySender = new Map<string, Agg>();
      for (const r of records) {
        const sender = r.sender_email.toLowerCase();
        const agg = bySender.get(sender) ?? { inbox: 0, spam: 0, google: null, microsoft: null };
        if (r.is_spam) agg.spam++;
        else agg.inbox++;
        const provider = await seedProvider(r.recipient_email);
        if (provider === "google" || provider === "microsoft") {
          // Any spam judgment at a provider marks the sender spam there.
          const verdict = r.is_spam ? "spam" : "inbox";
          if (agg[provider] !== "spam") agg[provider] = verdict;
        }
        bySender.set(sender, agg);
      }

      const tx = db.transaction(() => {
        for (const [sender, agg] of bySender) {
          const total = agg.inbox + agg.spam;
          const rate = total > 0 ? Math.round((agg.inbox / total) * 1000) / 10 : null;
          insert.run(sender, t.id, agg.google, agg.microsoft, rate);
        }
        db.prepare(
          "UPDATE placement_tests SET raw_results = ?, status = 'done', completed_at = datetime('now') WHERE id = ?",
        ).run(JSON.stringify({ recordCount: records.length, instantlyStatus: status }), t.id);
      });
      tx();
      completed++;
    } catch {
      // Leave as running; next poll retries. Tests older than 3 days flip to error.
      db.prepare(
        "UPDATE placement_tests SET status = 'error' WHERE id = ? AND created_at < datetime('now', '-3 days')",
      ).run(t.id);
    }
  }
  return `${completed}/${running.length} placement tests completed`;
}
