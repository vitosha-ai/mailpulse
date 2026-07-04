import { getDb } from "./db";
import { createPlacementTest, getPlacementAnalytics, getPlacementTest } from "./instantly";

// Placement test orchestration. Senders are tested in batches, oldest-tested
// first, so a weekly cadence naturally rotates through the whole fleet.

export function pickSendersForTest(batchSize: number): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.email,
              (SELECT MAX(tested_at) FROM placement_results pr WHERE pr.email = s.email) AS last_tested
       FROM senders s
       WHERE s.instantly_status = 1
       ORDER BY last_tested IS NOT NULL, last_tested ASC
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

// Poll running tests; when analytics come back, store raw JSON and extract
// per-sender verdicts as tolerantly as possible (the exact response shape is
// only verifiable with a live key, so parsing failures never lose data — the
// raw payload is always kept).
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
      const status = String((test as { status?: unknown }).status ?? "").toLowerCase();
      // Consider it done when the test object reports completion, or just try
      // analytics — absence of data keeps it 'running'.
      const analytics = await getPlacementAnalytics(t.instantly_test_id).catch(() => null);
      if (!analytics && !["completed", "done", "2"].includes(status)) continue;

      db.prepare("UPDATE placement_tests SET raw_results = ?, status = 'done', completed_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(analytics ?? test), t.id);
      extractVerdicts(t.id, analytics ?? test);
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

// Best-effort extraction: walks the analytics payload looking for per-email
// entries with provider-level inbox/spam placement.
function extractVerdicts(testId: number, payload: unknown) {
  const db = getDb();
  const emails = new Set(
    (JSON.parse(
      (db.prepare("SELECT emails FROM placement_tests WHERE id = ?").get(testId) as { emails: string })
        .emails,
    ) as string[]).map((e) => e.toLowerCase()),
  );

  const insert = db.prepare(`
    INSERT INTO placement_results (email, test_id, tested_at, google_verdict, microsoft_verdict, inbox_rate)
    VALUES (?, ?, datetime('now'), ?, ?, ?)
    ON CONFLICT(email, test_id) DO UPDATE SET
      google_verdict = excluded.google_verdict,
      microsoft_verdict = excluded.microsoft_verdict,
      inbox_rate = excluded.inbox_rate
  `);

  type Verdicts = { google?: string; microsoft?: string; inbox?: number; total?: number };
  const found = new Map<string, Verdicts>();

  const visit = (node: unknown, contextEmail: string | null) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, contextEmail);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    // Detect an email key on this object.
    let email = contextEmail;
    for (const k of ["email", "sender", "account", "from_email", "eaccount"]) {
      const v = obj[k];
      if (typeof v === "string" && emails.has(v.toLowerCase())) {
        email = v.toLowerCase();
        break;
      }
    }

    if (email) {
      const v = found.get(email) ?? {};
      const provider = String(obj.provider ?? obj.esp ?? obj.seed_provider ?? "").toLowerCase();
      const folder = String(obj.folder ?? obj.placement ?? obj.landed ?? "").toLowerCase();
      if (provider && folder) {
        const verdict = folder.includes("spam") || folder.includes("junk") ? "spam" : folder.includes("inbox") ? "inbox" : folder || "unknown";
        if (provider.includes("google") || provider.includes("gmail")) v.google = verdict;
        if (provider.includes("microsoft") || provider.includes("outlook") || provider.includes("office")) v.microsoft = verdict;
        v.total = (v.total ?? 0) + 1;
        if (verdict === "inbox") v.inbox = (v.inbox ?? 0) + 1;
      }
      // Direct rate fields, if the API provides aggregates.
      for (const k of ["inbox_rate", "inboxRate", "deliverability_score"]) {
        if (typeof obj[k] === "number") {
          v.inbox = obj[k] as number;
          v.total = 100;
        }
      }
      found.set(email, v);
    }

    for (const value of Object.values(obj)) visit(value, email);
  };
  visit(payload, null);

  for (const [email, v] of found) {
    const rate = v.total ? Math.round(((v.inbox ?? 0) / v.total) * 1000) / 10 : null;
    insert.run(email, testId, v.google ?? null, v.microsoft ?? null, rate);
  }
}
