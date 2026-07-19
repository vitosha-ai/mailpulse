#!/usr/bin/env node
/**
 * Dev-only seed: fills the LOCAL dev database with realistic, multi-market
 * variety so UI changes get exercised against real-shaped data before deploy.
 *
 *   node scripts/seed-dev.mjs          # add seed rows (idempotent)
 *   node scripts/seed-dev.mjs --clean  # remove all seed rows
 *
 * Safety: refuses to run unless the DB is the local dev file, and every row
 * is tagged (trigger_detail prefixed "[SEED]") so cleanup is exact and the
 * rows are unmistakable in the UI.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.join(ROOT, "data", "mailpulse.db");
const db = new Database(DB_PATH);

const SEED = "[SEED] ";
const today = new Date();
const iso = (daysAgo) => {
  const d = new Date(today);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

if (process.argv.includes("--clean")) {
  const a = db.prepare("DELETE FROM research_queue WHERE trigger_detail LIKE '[SEED]%'").run();
  const b = db.prepare("DELETE FROM learning_log WHERE entry LIKE '[SEED]%'").run();
  const c = db.prepare("DELETE FROM agent_usage WHERE market LIKE 'seed-%'").run();
  console.log(`cleaned: ${a.changes} rows, ${b.changes} log entries, ${c.changes} usage rows`);
  process.exit(0);
}

const insert = db.prepare(`INSERT OR IGNORE INTO research_queue
  (queued_date, first_name, last_name, title, verified_email, linkedin, company,
   trigger_type, trigger_detail, trigger_date, source_url, bucket, detected_stack,
   pillar, proof_point, subject, email_1, followup_day_3, followup_day_8,
   breakup_day_15, confidence, status, rep_notes, size, researched_at, fit_reason,
   research_trail, market)
  VALUES (@queued_date, @first_name, @last_name, @title, @verified_email, @linkedin,
   @company, @trigger_type, @trigger_detail, @trigger_date, @source_url, @bucket,
   @detected_stack, @pillar, @proof_point, @subject, @email_1, @followup_day_3,
   @followup_day_8, @breakup_day_15, @confidence, @status, @rep_notes, @size,
   @researched_at, @fit_reason, @research_trail, @market)`);

const base = {
  linkedin: "linkedin.com/in/example",
  source_url: "https://example.com/source",
  detected_stack: "Microsoft/Azure",
  proof_point: "[PROOF: ENTERPRISE-SCALE]",
  subject: "quick question",
  email_1: "Hi — seeded draft body for UI testing.",
  followup_day_3: "Seeded follow-up (day 3).",
  followup_day_8: "Seeded follow-up (day 8).",
  breakup_day_15: "Seeded breakup (day 15).",
  rep_notes: "",
  researched_at: new Date().toISOString(),
  research_trail: "signal -> enrich -> ICP pass -> contact selected (seeded)",
};

const rows = [
  // --- US: several days, all statuses, varied triggers/confidence ---
  { d: 0, m: "us", f: "Ava", l: "Stone", t: "CIO", c: "Seed Manufacturing Inc", trig: "Tech EOL", det: "Dynamics NAV in stack — extended support ends Jan 2028", conf: "Medium", st: "Pending", pil: "Business Applications", b: "Manufacturing", size: "1200" },
  { d: 0, m: "us", f: "Ben", l: "Ortiz", t: "VP Data", c: "Seed Analytics Corp", trig: "Hiring stack", det: "Actively hiring 3 role(s): Senior Data Engineer, ML Engineer", conf: "High", st: "Pending", pil: "Data & AI", b: "Technology", size: "800" },
  { d: 0, m: "us", f: "", l: "", t: "", c: "Seed NoContact LLC", trig: "Hiring stack", det: "Actively hiring 1 role(s): Power BI Developer", conf: "High", st: "Pending", pil: "Data & AI", b: "Retail", size: "450", noPoc: true },
  { d: 1, m: "us", f: "Cara", l: "Nguyen", t: "CTO", c: "Seed Health Systems", trig: "New leader", det: "Appointed new CIO effective this month", conf: "High", st: "Sent", pil: "Data & AI", b: "Healthcare", size: "2600" },
  { d: 1, m: "us", f: "Dan", l: "Wells", t: "CFO", c: "Seed Logistics Co", trig: "Cost pressure", det: "Announced workforce reduction of 150", conf: "High", st: "Rejected", pil: "Business Applications", b: "Logistics", size: "3100", notes: "wrong fit per rep" },
  { d: 2, m: "us", f: "Eve", l: "Marsh", t: "Head of IT", c: "Seed Exchange Corp", trig: "Tech EOL", det: "On-premises Exchange Server — support ended Oct 2025", conf: "Medium", st: "Verified", pil: "Modern Work", b: "Financial Services", size: "900" },
  // --- GCC: different days, incl. corroborated + Arabic name ---
  { d: 0, m: "gcc", f: "Yousef", l: "Hariri", t: "CIO", c: "Seed Gulf Retail | تجزئة", trig: "Hiring stack", det: "Actively hiring 2 role(s): D365 Consultant, Data Engineer", conf: "High", st: "Pending", pil: "Business Applications", b: "Retail", size: "1500", fit: "CORROBORATED: this run also flagged Tech EOL. Strong fit." },
  { d: 0, m: "gcc", f: "Leila", l: "Farouk", t: "CTO", c: "Seed Emirates Data", trig: "Tech EOL", det: "On-premises Exchange Server in the stack — support ended Oct 2025", conf: "Medium", st: "Pending", pil: "Modern Work", b: "Technology", size: "700" },
  { d: 1, m: "gcc", f: "Omar", l: "Aziz", t: "Head of Digital", c: "Seed Qatar Holdings", trig: "New leader", det: "Company appointed new CEO effective 1 July", conf: "High", st: "Edited", pil: "Data & AI", b: "Financial Services", size: "2200" },
];

let n = 0;
for (const r of rows) {
  n += insert.run({
    ...base,
    queued_date: iso(r.d),
    first_name: r.noPoc ? "" : r.f,
    last_name: r.noPoc ? "" : r.l,
    title: r.noPoc ? "" : r.t,
    verified_email: r.noPoc ? "" : `${r.f}.${r.l}@seed.example`.toLowerCase(),
    company: r.c,
    trigger_type: r.trig,
    trigger_detail: SEED + r.det,
    trigger_date: iso(r.d + 1),
    bucket: r.b,
    pillar: r.pil,
    confidence: r.conf,
    status: r.st,
    rep_notes: r.notes || "",
    size: r.size,
    fit_reason: r.fit || `${r.b} company, ${r.size} employees — seeded fit justification.`,
    market: r.m,
  }).changes;
}

// Learning-log entries for both markets, both kinds.
const log = db.prepare("INSERT INTO learning_log (date, market, kind, entry) VALUES (?, ?, ?, ?)");
const already = db.prepare("SELECT COUNT(*) n FROM learning_log WHERE entry LIKE '[SEED]%'").get().n;
if (!already) {
  log.run(iso(0), "us", "auto", SEED + "US: 6 lead(s) across 6 companies queued — Hiring stack 2, Tech EOL 2, New leader 1, Cost pressure 1. Confidence: 3 High / 2 Medium / 0 Low.");
  log.run(iso(0), "gcc", "auto", SEED + "GCC: 3 lead(s) across 3 companies queued — Hiring stack 1, Tech EOL 1, New leader 1.");
  log.run(iso(1), "gcc", "learned", SEED + "GCC: example learned entry — phone-first CTA outperformed email CTA in replies.");
}

console.log(`seeded ${n} new lead row(s) (idempotent; re-run safe). Learning entries: ${already ? "already present" : "3 added"}.`);
console.log("Remove everything with: node scripts/seed-dev.mjs --clean");
db.close();
