import { getDb } from "./db";

// Combined health score per sender, 0-100, plus traffic-light status and
// trend-based alert rules. Signals are weighted by how "genuine" they are:
// real placement tests count most, warmup analytics next, campaign stats and
// domain hygiene round it out. Missing signals redistribute their weight.

export type SenderSignals = {
  email: string;
  domain: string;
  warmupScore: number | null; // Instantly health score 0-100
  warmupInboxRate7d: number | null; // 0-100, from warmup_daily last 7 days
  placementInboxRate: number | null; // 0-100, most recent test within 14 days
  bounceRate: number | null; // percent
  authScore: number | null; // 0-100 from SPF/DKIM/DMARC
  blocklisted: boolean;
};

const WEIGHTS = {
  placement: 0.35,
  warmupScore: 0.25,
  warmupInbox: 0.2,
  bounce: 0.1,
  auth: 0.1,
};

export function combinedScore(s: SenderSignals): number | null {
  const parts: { value: number; weight: number }[] = [];
  if (s.placementInboxRate !== null) parts.push({ value: s.placementInboxRate, weight: WEIGHTS.placement });
  if (s.warmupScore !== null) parts.push({ value: s.warmupScore, weight: WEIGHTS.warmupScore });
  if (s.warmupInboxRate7d !== null) parts.push({ value: s.warmupInboxRate7d, weight: WEIGHTS.warmupInbox });
  if (s.bounceRate !== null) {
    // 0% bounce → 100; 5%+ → 0. Linear in between.
    parts.push({ value: Math.max(0, 100 - s.bounceRate * 20), weight: WEIGHTS.bounce });
  }
  if (s.authScore !== null) parts.push({ value: s.authScore, weight: WEIGHTS.auth });

  if (parts.length === 0) return null;
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  let score = parts.reduce((sum, p) => sum + p.value * (p.weight / totalWeight), 0);

  // A blocklisted domain caps the score — nothing else can compensate.
  if (s.blocklisted) score = Math.min(score, 25);
  return Math.round(score * 10) / 10;
}

export function healthStatus(score: number | null, blocklisted: boolean, degrading: boolean): string {
  if (score === null) return "unknown";
  if (blocklisted || score < 60) return "red";
  if (score < 80 || degrading) return "yellow";
  return "green";
}

export type AlertCandidate = {
  target: string;
  target_type: "sender" | "domain";
  rule: string;
  severity: "warn" | "critical";
  message: string;
};

// Trend + threshold rules. Called at the end of each sync with fresh data.
export function evaluateRules(input: {
  email: string;
  domain: string;
  score: number | null;
  scoreThreeDaysAgo: number | null;
  warmupSpamRate7d: number | null; // percent of warmup mail landing in spam
  bounceRate: number | null;
  blocklisted: boolean;
  blocklistNames: string[];
}): AlertCandidate[] {
  const alerts: AlertCandidate[] = [];
  const { email, domain } = input;

  if (input.blocklisted) {
    alerts.push({
      target: domain,
      target_type: "domain",
      rule: "blocklist",
      severity: "critical",
      message: `Domain ${domain} is on a blocklist (${input.blocklistNames.join(", ")}). Pause all senders on this domain.`,
    });
  }
  if (input.score !== null && input.scoreThreeDaysAgo !== null && input.scoreThreeDaysAgo - input.score >= 10) {
    alerts.push({
      target: email,
      target_type: "sender",
      rule: "score-drop",
      severity: "warn",
      message: `${email}: health score dropped ${Math.round(input.scoreThreeDaysAgo - input.score)} points in 3 days (${input.scoreThreeDaysAgo} → ${input.score}). Slow down this sender.`,
    });
  }
  if (input.warmupSpamRate7d !== null && input.warmupSpamRate7d >= 5) {
    alerts.push({
      target: email,
      target_type: "sender",
      rule: "warmup-spam",
      severity: input.warmupSpamRate7d >= 15 ? "critical" : "warn",
      message: `${email}: ${input.warmupSpamRate7d.toFixed(1)}% of warmup mail landed in spam over the last 7 days.`,
    });
  }
  if (input.bounceRate !== null && input.bounceRate >= 3) {
    alerts.push({
      target: email,
      target_type: "sender",
      rule: "bounce-rate",
      severity: input.bounceRate >= 8 ? "critical" : "warn",
      message: `${email}: bounce rate is ${input.bounceRate.toFixed(1)}%. Microsoft/Google throttle senders that bounce; pause and inspect.`,
    });
  }
  if (input.score !== null && input.score < 60) {
    alerts.push({
      target: email,
      target_type: "sender",
      rule: "score-low",
      severity: "critical",
      message: `${email}: combined health score is ${input.score} (<60). Pause this sender now.`,
    });
  }
  return alerts;
}

// Insert alerts, skipping duplicates that are still open for the same
// target+rule (so a degrading sender doesn't create a new alert every sync).
export function recordAlerts(alerts: AlertCandidate[]) {
  const db = getDb();
  const existing = db
    .prepare("SELECT target, rule FROM alerts WHERE resolved_at IS NULL")
    .all() as { target: string; rule: string }[];
  const open = new Set(existing.map((a) => `${a.target}|${a.rule}`));
  const insert = db.prepare(
    "INSERT INTO alerts (target, target_type, rule, severity, message) VALUES (?, ?, ?, ?, ?)",
  );
  let added = 0;
  for (const a of alerts) {
    if (open.has(`${a.target}|${a.rule}`)) continue;
    insert.run(a.target, a.target_type, a.rule, a.severity, a.message);
    added++;
  }
  return added;
}
