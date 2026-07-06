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
  db = new Database(path.join(DATA_DIR, "mailpulse.db"));
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
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

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      kind TEXT NOT NULL,   -- instantly | saleshandy | smartlead | domains | placement | full
      ok INTEGER,
      detail TEXT
    );
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
    "ALTER TABLE senders ADD COLUMN campaigns TEXT", // JSON [{id,name,status}] from the sender's sequencer
    "ALTER TABLE senders ADD COLUMN retire_requested TEXT", // timestamp when user asked for graceful pause
    "ALTER TABLE senders ADD COLUMN sh_zero_days INTEGER DEFAULT 0",
    "ALTER TABLE senders ADD COLUMN sh_zero_checked TEXT", // date of last zero-day increment
  ];
  for (const stmt of addColumns) {
    try {
      db.exec(stmt);
    } catch {
      // column already exists
    }
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
