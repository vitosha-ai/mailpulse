import { getDb } from "./db";
import { listAllAccounts, warmupAnalytics } from "./instantly";
import { listAllEmailAccounts, emailAccountStats, providerFromEsp } from "./saleshandy";
import { listAllAccounts as listSmartleadAccounts } from "./smartlead";
import { checkDomain } from "./dnschecks";
import { combinedScore, healthStatus, evaluateRules, recordAlerts, type AlertCandidate } from "./scoring";

// Orchestrates a full data refresh. Each stage is independent — a failing
// stage (e.g. missing API key) logs and moves on so the others still run.

export type SyncReport = {
  instantly: string;
  saleshandy: string;
  smartlead: string;
  domains: string;
  scoring: string;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function logSync(kind: string, ok: boolean, detail: string) {
  getDb()
    .prepare("INSERT INTO sync_log (kind, ok, detail, finished_at) VALUES (?, ?, ?, datetime('now'))")
    .run(kind, ok ? 1 : 0, detail);
}

export async function syncInstantly(): Promise<string> {
  const db = getDb();
  try {
    const accounts = await listAllAccounts();
    const upsert = db.prepare(`
      INSERT INTO senders (email, domain, provider, instantly_status, warmup_status, warmup_score, daily_limit, last_synced)
      VALUES (@email, @domain, @provider, @instantly_status, @warmup_status, @warmup_score, @daily_limit, datetime('now'))
      ON CONFLICT(email) DO UPDATE SET
        domain = excluded.domain,
        provider = excluded.provider,
        instantly_status = excluded.instantly_status,
        warmup_status = excluded.warmup_status,
        warmup_score = excluded.warmup_score,
        daily_limit = excluded.daily_limit,
        last_synced = excluded.last_synced
    `);
    const providerFromCode = (code: number): string =>
      code === 2 ? "google" : code === 3 ? "microsoft" : code === 1 ? "maildoso" : "other";

    const tx = db.transaction(() => {
      for (const a of accounts) {
        upsert.run({
          email: a.email.toLowerCase(),
          domain: domainOf(a.email),
          provider: providerFromCode(a.provider_code),
          instantly_status: a.status,
          warmup_status: a.warmup_status,
          warmup_score: a.stat_warmup_score,
          daily_limit: a.daily_limit,
        });
      }
    });
    tx();

    // Warmup analytics in batches of 100 (API max).
    const emails = accounts.map((a) => a.email.toLowerCase());
    const insertDay = db.prepare(`
      INSERT INTO warmup_daily (email, date, sent, landed_inbox, landed_spam, received)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(email, date) DO UPDATE SET
        sent = excluded.sent, landed_inbox = excluded.landed_inbox,
        landed_spam = excluded.landed_spam, received = excluded.received
    `);
    const setScore = db.prepare("UPDATE senders SET warmup_score = ? WHERE email = ?");

    for (let i = 0; i < emails.length; i += 100) {
      const batch = emails.slice(i, i + 100);
      const analytics = await warmupAnalytics(batch);
      const tx2 = db.transaction(() => {
        for (const [email, days] of Object.entries(analytics.email_date_data ?? {})) {
          for (const [date, d] of Object.entries(days)) {
            insertDay.run(
              email.toLowerCase(),
              date.slice(0, 10),
              d.sent ?? 0,
              d.landed_inbox ?? 0,
              d.landed_spam ?? 0,
              d.received ?? 0,
            );
          }
        }
        for (const [email, agg] of Object.entries(analytics.aggregate_data ?? {})) {
          if (typeof agg.health_score === "number") setScore.run(agg.health_score, email.toLowerCase());
        }
      });
      tx2();
    }
    const msg = `${accounts.length} accounts synced from Instantly`;
    logSync("instantly", true, msg);
    return msg;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logSync("instantly", false, msg);
    return `Instantly sync failed: ${msg}`;
  }
}

export async function syncSaleshandy(): Promise<string> {
  const db = getDb();
  try {
    const accounts = await listAllEmailAccounts();
    const update = db.prepare(`
      UPDATE senders SET
        saleshandy_id = ?, saleshandy_status = ?,
        daily_limit = COALESCE(daily_limit, ?),
        provider = CASE WHEN provider = 'other' AND ? IS NOT NULL THEN ? ELSE provider END
      WHERE email = ?
    `);
    const insertMissing = db.prepare(`
      INSERT OR IGNORE INTO senders (email, domain, provider, saleshandy_id, last_synced)
      VALUES (?, ?, 'other', ?, datetime('now'))
    `);
    for (const a of accounts) {
      insertMissing.run(a.email, domainOf(a.email), a.id);
      const prov = providerFromEsp(a.esp);
      update.run(a.id, a.status != null ? String(a.status) : null, a.dailyLimit, prov, prov, a.email);
    }

    // Per-account stats: one call each. Saleshandy rate-limits aggressively
    // (observed: cuts off after ~20 rapid calls), so pace at ~1 call/1.2 s and
    // give failures a slower second pass.
    const setStats = db.prepare(
      "UPDATE senders SET bounce_rate = ?, sh_setup_score = ?, sh_inbox_score = ? WHERE email = ?",
    );
    let ok = 0;
    const fetchStats = async (a: (typeof accounts)[number]) => {
      const stats = await emailAccountStats(a.id);
      setStats.run(stats.bounceRate, stats.setupScore, stats.inboxScore, a.email);
      ok++;
    };
    const retryLater: typeof accounts = [];
    for (const a of accounts) {
      try {
        await fetchStats(a);
      } catch {
        retryLater.push(a);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    let failed = 0;
    for (const a of retryLater) {
      try {
        await fetchStats(a);
      } catch {
        failed++;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    const msg = `${accounts.length} Saleshandy accounts; stats ok=${ok} failed=${failed}`;
    logSync("saleshandy", true, msg);
    return msg;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logSync("saleshandy", false, msg);
    return `Saleshandy sync failed: ${msg}`;
  }
}

export async function syncSmartlead(): Promise<string> {
  const db = getDb();
  try {
    const accounts = await listSmartleadAccounts();
    const insertMissing = db.prepare(`
      INSERT OR IGNORE INTO senders (email, domain, provider, last_synced)
      VALUES (?, ?, 'other', datetime('now'))
    `);
    const update = db.prepare(`
      UPDATE senders SET
        smartlead_id = ?, smartlead_status = ?, sl_warmup_reputation = ?,
        sl_smtp_ok = ?, sl_imap_ok = ?
      WHERE email = ?
    `);
    const flag = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

    const alerts: AlertCandidate[] = [];
    for (const a of accounts) {
      insertMissing.run(a.email, domainOf(a.email));
      update.run(
        String(a.id),
        a.status,
        a.warmupReputation,
        flag(a.smtpOk),
        flag(a.imapOk),
        a.email,
      );
      // Smartlead silently skips disconnected senders in campaigns — surface it loudly.
      if (a.smtpOk === false || a.imapOk === false) {
        alerts.push({
          target: a.email,
          target_type: "sender",
          rule: "smartlead-disconnected",
          severity: "critical",
          message: `${a.email}: Smartlead reports this mailbox as disconnected (${a.smtpOk === false ? "SMTP" : ""}${a.smtpOk === false && a.imapOk === false ? " + " : ""}${a.imapOk === false ? "IMAP" : ""} failing). Smartlead silently skips it in campaigns — reconnect it in Smartlead.`,
        });
      }
    }
    const added = recordAlerts(alerts);
    const msg = `${accounts.length} Smartlead accounts synced, ${added} disconnect alert(s)`;
    logSync("smartlead", true, msg);
    return msg;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logSync("smartlead", false, msg);
    return `Smartlead sync failed: ${msg}`;
  }
}

export async function syncDomains(): Promise<string> {
  const db = getDb();
  try {
    const domains = (
      db.prepare("SELECT DISTINCT domain FROM senders WHERE domain != ''").all() as { domain: string }[]
    ).map((r) => r.domain);

    const upsert = db.prepare(`
      INSERT INTO domain_checks (domain, checked_at, mx_ok, mx_provider, spf_ok, spf_record, dkim_ok, dkim_selector, dmarc_ok, dmarc_record, blocklists)
      VALUES (@domain, datetime('now'), @mx_ok, @mx_provider, @spf_ok, @spf_record, @dkim_ok, @dkim_selector, @dmarc_ok, @dmarc_record, @blocklists)
      ON CONFLICT(domain) DO UPDATE SET
        checked_at = excluded.checked_at, mx_ok = excluded.mx_ok, mx_provider = excluded.mx_provider,
        spf_ok = excluded.spf_ok, spf_record = excluded.spf_record, dkim_ok = excluded.dkim_ok,
        dkim_selector = excluded.dkim_selector, dmarc_ok = excluded.dmarc_ok,
        dmarc_record = excluded.dmarc_record, blocklists = excluded.blocklists
    `);

    // Concurrency 10 — DNS checks are cheap but 300 domains × several lookups
    // each adds up.
    let done = 0;
    for (let i = 0; i < domains.length; i += 10) {
      const batch = domains.slice(i, i + 10);
      const results = await Promise.all(batch.map((d) => checkDomain(d).catch(() => null)));
      for (const r of results) {
        if (!r) continue;
        upsert.run({
          domain: r.domain,
          mx_ok: r.mx_ok ? 1 : 0,
          mx_provider: r.mx_provider,
          spf_ok: r.spf_ok ? 1 : 0,
          spf_record: r.spf_record,
          dkim_ok: r.dkim_ok ? 1 : 0,
          dkim_selector: r.dkim_selector,
          dmarc_ok: r.dmarc_ok ? 1 : 0,
          dmarc_record: r.dmarc_record,
          blocklists: JSON.stringify(r.blocklists),
        });
        done++;
      }
    }
    const msg = `${done}/${domains.length} domains checked`;
    logSync("domains", true, msg);
    return msg;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logSync("domains", false, msg);
    return `Domain checks failed: ${msg}`;
  }
}

// Recompute combined scores + statuses, write history, fire alert rules.
export function rescoreAll(): string {
  const db = getDb();
  const senders = db.prepare("SELECT * FROM senders").all() as Record<string, unknown>[];
  const date = today();

  const warmup7d = db.prepare(`
    SELECT SUM(landed_inbox) AS inbox, SUM(landed_spam) AS spam
    FROM warmup_daily WHERE email = ? AND date >= date('now', '-7 days')
  `);
  const placement = db.prepare(`
    SELECT inbox_rate FROM placement_results
    WHERE email = ? AND tested_at >= datetime('now', '-14 days')
    ORDER BY tested_at DESC LIMIT 1
  `);
  const domainCheck = db.prepare("SELECT * FROM domain_checks WHERE domain = ?");
  const scoreAgo = db.prepare(`
    SELECT combined_score FROM score_history
    WHERE email = ? AND date <= date('now', '-3 days')
    ORDER BY date DESC LIMIT 1
  `);
  const writeHistory = db.prepare(`
    INSERT INTO score_history (email, date, combined_score, warmup_score, bounce_rate, health_status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email, date) DO UPDATE SET
      combined_score = excluded.combined_score, warmup_score = excluded.warmup_score,
      bounce_rate = excluded.bounce_rate, health_status = excluded.health_status
  `);
  const setScore = db.prepare("UPDATE senders SET combined_score = ?, health_status = ? WHERE email = ?");

  const allAlerts = [];
  for (const s of senders) {
    const email = s.email as string;
    const domain = s.domain as string;

    const w = warmup7d.get(email) as { inbox: number | null; spam: number | null };
    const wTotal = (w.inbox ?? 0) + (w.spam ?? 0);
    const warmupInboxRate = wTotal > 0 ? (100 * (w.inbox ?? 0)) / wTotal : null;
    const warmupSpamRate = wTotal > 0 ? (100 * (w.spam ?? 0)) / wTotal : null;

    const p = placement.get(email) as { inbox_rate: number } | undefined;
    const dc = domainCheck.get(domain) as Record<string, unknown> | undefined;

    let authScore: number | null = null;
    let blocklisted = false;
    let blocklistNames: string[] = [];
    if (dc) {
      authScore =
        ((dc.spf_ok ? 1 : 0) + (dc.dkim_ok ? 1 : 0) + (dc.dmarc_ok ? 1 : 0)) * (100 / 3);
      const bls = JSON.parse((dc.blocklists as string) ?? "[]") as { list: string; listed: boolean }[];
      blocklistNames = bls.filter((b) => b.listed).map((b) => b.list);
      blocklisted = blocklistNames.length > 0;
    }

    const score = combinedScore({
      email,
      domain,
      warmupScore: (s.warmup_score as number) ?? null,
      warmupInboxRate7d: warmupInboxRate,
      placementInboxRate: p?.inbox_rate ?? null,
      bounceRate: (s.bounce_rate as number) ?? null,
      authScore,
      blocklisted,
    });

    const prev = scoreAgo.get(email) as { combined_score: number | null } | undefined;
    const degrading =
      score !== null && prev?.combined_score != null && prev.combined_score - score >= 10;
    const status = healthStatus(score, blocklisted, degrading);

    writeHistory.run(email, date, score, (s.warmup_score as number) ?? null, (s.bounce_rate as number) ?? null, status);
    setScore.run(score, status, email);

    allAlerts.push(
      ...evaluateRules({
        email,
        domain,
        score,
        scoreThreeDaysAgo: prev?.combined_score ?? null,
        warmupSpamRate7d: warmupSpamRate,
        bounceRate: (s.bounce_rate as number) ?? null,
        blocklisted,
        blocklistNames,
      }),
    );
  }
  const added = recordAlerts(allAlerts);
  const msg = `${senders.length} senders rescored, ${added} new alerts`;
  logSync("scoring", true, msg);
  return msg;
}

export async function fullSync(): Promise<SyncReport> {
  const instantly = await syncInstantly();
  const saleshandy = await syncSaleshandy();
  const smartlead = await syncSmartlead();
  const domains = await syncDomains();
  const scoring = rescoreAll();
  logSync("full", true, "full sync complete");
  return { instantly, saleshandy, smartlead, domains, scoring };
}
