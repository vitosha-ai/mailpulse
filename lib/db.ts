import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// Single local SQLite file. All state lives here so the app has no external
// database dependency.
const DATA_DIR = path.join(process.cwd(), "data");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  applyIncomingIfPresent();
  db = new Database(path.join(DATA_DIR, "mailpulse.db"));
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

// Host migration: if an uploaded database is waiting (data/incoming.db), make
// it the live database before opening. Runs before any connection is held.
function applyIncomingIfPresent() {
  const incoming = path.join(DATA_DIR, "incoming.db");
  if (!fs.existsSync(incoming)) return;
  const main = path.join(DATA_DIR, "mailpulse.db");
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = main + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    fs.renameSync(incoming, main);
    console.log("[db] applied incoming.db as the live database");
  } catch (e) {
    console.error("[db] failed to apply incoming.db:", e instanceof Error ? e.message : e);
  }
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS senders (
      email TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'other', -- maildoso | google | microsoft | other
      instantly_status INTEGER,               -- 1 active, 2 paused, 3 maintenance, <0 errors
      warmup_status INTEGER,                  -- 1 active, 0 paused, <0 banned/suspended
      warmup_score REAL,                      -- Instantly stat_warmup_score / health_score (0-100)
      daily_limit INTEGER,
      saleshandy_id TEXT,
      saleshandy_status TEXT,
      bounce_rate REAL,
      sh_setup_score REAL,
      sh_inbox_score REAL,
      combined_score REAL,
      health_status TEXT NOT NULL DEFAULT 'unknown', -- green | yellow | red | unknown
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_synced TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_senders_domain ON senders(domain);

    -- Daily per-sender warmup numbers from Instantly (the trend source).
    CREATE TABLE IF NOT EXISTS warmup_daily (
      email TEXT NOT NULL,
      date TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      landed_inbox INTEGER NOT NULL DEFAULT 0,
      landed_spam INTEGER NOT NULL DEFAULT 0,
      received INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (email, date)
    );

    -- One row per sender per sync day: the combined score history.
    CREATE TABLE IF NOT EXISTS score_history (
      email TEXT NOT NULL,
      date TEXT NOT NULL,
      combined_score REAL,
      warmup_score REAL,
      bounce_rate REAL,
      health_status TEXT,
      PRIMARY KEY (email, date)
    );

    CREATE TABLE IF NOT EXISTS domain_checks (
      domain TEXT PRIMARY KEY,
      checked_at TEXT,
      mx_ok INTEGER,
      mx_provider TEXT,
      spf_ok INTEGER,
      spf_record TEXT,
      dkim_ok INTEGER,
      dkim_selector TEXT,
      dmarc_ok INTEGER,
      dmarc_record TEXT,
      blocklists TEXT -- JSON: [{list, listed, code, error}]
    );

    CREATE TABLE IF NOT EXISTS placement_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instantly_test_id TEXT,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'created', -- created | running | done | error
      emails TEXT NOT NULL,                   -- JSON array of sender emails in this batch
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      raw_results TEXT                        -- JSON from Instantly analytics
    );

    -- Per-sender verdicts extracted from placement test results.
    CREATE TABLE IF NOT EXISTS placement_results (
      email TEXT NOT NULL,
      test_id INTEGER NOT NULL,
      tested_at TEXT NOT NULL,
      google_verdict TEXT,    -- inbox | spam | missing | unknown
      microsoft_verdict TEXT,
      inbox_rate REAL,        -- overall % across seed providers
      PRIMARY KEY (email, test_id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,          -- sender email or domain
      target_type TEXT NOT NULL,     -- sender | domain
      rule TEXT NOT NULL,            -- machine name of the rule that fired
      severity TEXT NOT NULL,        -- warn | critical
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(resolved_at) WHERE resolved_at IS NULL;

    CREATE TABLE IF NOT EXISTS inbox_messages (
      uid INTEGER PRIMARY KEY,          -- surrogate id (IMAP uid for maildoso; offset-based for api sources)
      source TEXT NOT NULL DEFAULT 'maildoso', -- maildoso | google | microsoft
      ext_id TEXT,                      -- provider message id (IMAP uid / Gmail id / Graph id)
      message_id TEXT,
      from_email TEXT,
      from_name TEXT,
      to_email TEXT,                    -- which of our senders it replied to
      subject TEXT,
      preview TEXT,                     -- first ~300 chars of body text
      body TEXT,                        -- full plain-text body
      received_at TEXT,
      category TEXT,                    -- interested | out-of-office | unsubscribe | auto-reply | other
      is_warmup INTEGER NOT NULL DEFAULT 0,
      seen INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox_messages(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inbox_category ON inbox_messages(category);

    -- User-created tags (the palette) and which messages carry them.
    CREATE TABLE IF NOT EXISTS inbox_tags (
      name TEXT PRIMARY KEY,
      color TEXT NOT NULL DEFAULT 'slate',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inbox_message_tags (
      uid INTEGER NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (uid, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_msgtags_tag ON inbox_message_tags(tag);

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      kind TEXT NOT NULL,   -- instantly | saleshandy | smartlead | domains | placement | full
      ok INTEGER,
      detail TEXT
    );

    -- Outbound research queue, written nightly by the Vitosha research agent
    -- (a separate Python process sharing this database file). One row = one
    -- contact at one triggered account, with a pre-drafted 4-email sequence.
    -- The agent researches + drafts only; every send is a human action here.
    CREATE TABLE IF NOT EXISTS research_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queued_date TEXT NOT NULL,            -- ISO date the agent produced the row
      first_name TEXT, last_name TEXT, title TEXT, verified_email TEXT, linkedin TEXT,
      company TEXT, trigger_type TEXT, trigger_detail TEXT, trigger_date TEXT, source_url TEXT,
      bucket TEXT, detected_stack TEXT, pillar TEXT, proof_point TEXT,
      subject TEXT, email_1 TEXT, followup_day_3 TEXT, followup_day_8 TEXT, breakup_day_15 TEXT,
      confidence TEXT,                      -- High | Medium | Low
      status TEXT NOT NULL DEFAULT 'Pending', -- Pending|Verified|Edited|Sent|Rejected|Skipped
      rep_notes TEXT,
      size TEXT,                            -- company headcount
      researched_at TEXT,                   -- when the agent produced the row
      fit_reason TEXT,                      -- technology / pillar / ICP justification
      research_trail TEXT,                  -- step-by-step provenance
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(queued_date, verified_email, trigger_detail)
    );
    CREATE INDEX IF NOT EXISTS idx_rq_date ON research_queue(queued_date DESC);
    CREATE INDEX IF NOT EXISTS idx_rq_status ON research_queue(status);

    -- One row per agent run: what that run consumed (Apollo credits, Claude
    -- tokens, Apify runs) and the estimated $ cost. Written by the agent via
    -- /api/outbound/ingest; the Outbound page aggregates day/week/month.
    CREATE TABLE IF NOT EXISTS agent_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT NOT NULL,
      apollo_enrichments INTEGER DEFAULT 0,
      apollo_reveals INTEGER DEFAULT 0,
      apollo_credits INTEGER DEFAULT 0,
      apollo_cost_usd REAL DEFAULT 0,
      anthropic_calls INTEGER DEFAULT 0,
      anthropic_input_tokens INTEGER DEFAULT 0,
      anthropic_output_tokens INTEGER DEFAULT 0,
      anthropic_cost_usd REAL DEFAULT 0,
      apify_runs INTEGER DEFAULT 0,
      apify_cost_usd REAL DEFAULT 0,
      brightdata_records INTEGER DEFAULT 0,
      brightdata_cost_usd REAL DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_date ON agent_usage(run_date DESC);
  `);

  // Additive migrations for databases created before these columns existed.
  const addColumns = [
    "ALTER TABLE senders ADD COLUMN smartlead_id TEXT",
    "ALTER TABLE senders ADD COLUMN smartlead_status TEXT",
    "ALTER TABLE senders ADD COLUMN sl_warmup_reputation REAL",
    "ALTER TABLE senders ADD COLUMN sl_smtp_ok INTEGER",
    "ALTER TABLE senders ADD COLUMN sl_imap_ok INTEGER",
    "ALTER TABLE senders ADD COLUMN trulyinbox_id TEXT",
    "ALTER TABLE senders ADD COLUMN ti_status TEXT",
    "ALTER TABLE senders ADD COLUMN ti_score REAL",
    "ALTER TABLE senders ADD COLUMN est_daily_volume REAL",
    "ALTER TABLE senders ADD COLUMN sh_used_today INTEGER",
    "ALTER TABLE inbox_messages ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE inbox_messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE senders ADD COLUMN campaigns TEXT", // JSON [{id,name,status}] from the sender's sequencer
    "ALTER TABLE senders ADD COLUMN retire_requested TEXT", // timestamp when user asked for graceful pause
    "ALTER TABLE senders ADD COLUMN sh_zero_days INTEGER DEFAULT 0",
    "ALTER TABLE senders ADD COLUMN sh_zero_checked TEXT", // date of last zero-day increment
    "ALTER TABLE inbox_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'maildoso'",
    "ALTER TABLE inbox_messages ADD COLUMN ext_id TEXT",
    "ALTER TABLE inbox_messages ADD COLUMN is_reply INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE research_queue ADD COLUMN size TEXT",
    "ALTER TABLE research_queue ADD COLUMN researched_at TEXT",
    "ALTER TABLE research_queue ADD COLUMN fit_reason TEXT",
    "ALTER TABLE research_queue ADD COLUMN research_trail TEXT",
    "ALTER TABLE agent_usage ADD COLUMN brightdata_records INTEGER DEFAULT 0",
    "ALTER TABLE agent_usage ADD COLUMN brightdata_cost_usd REAL DEFAULT 0",
  ];
  for (const stmt of addColumns) {
    try {
      db.exec(stmt);
    } catch {
      // column already exists
    }
  }

  // Backfill ext_id for existing (maildoso/IMAP) rows, then enforce dedup by
  // (source, ext_id) so multiple mail sources coexist without id collisions.
  try {
    db.exec("UPDATE inbox_messages SET ext_id = CAST(uid AS TEXT) WHERE ext_id IS NULL");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_srcext ON inbox_messages(source, ext_id)");
  } catch {
    // best effort
  }
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}
