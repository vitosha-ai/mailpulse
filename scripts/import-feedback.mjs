#!/usr/bin/env node
/**
 * Excel feedback importer — reads the reps' WORKED export files from the drop
 * folder and merges their verdicts back into research_queue via
 * POST /api/outbound/feedback.
 *
 *   Drop folder : C:\mailpulse\feedback\inbox   (all .xlsx files inside)
 *   Usage       : node scripts/import-feedback.mjs [--url <mailpulse-url>]
 *   Auth        : MP_TOKEN env var (= OUTBOUND_INGEST_TOKEN). Example:
 *                 MP_TOKEN=$(railway variables --service mailpulse --kv | sed -n 's/^OUTBOUND_INGEST_TOKEN=//p') \
 *                   node scripts/import-feedback.mjs
 *
 * Guarantees:
 *   - rep files are opened READ-ONLY and never modified or moved
 *   - Pending never overwrites anything
 *   - if two files disagree on the same lead (different non-Pending statuses),
 *     the lead is FLAGGED and skipped — never guessed
 *   - re-running on the same files is harmless (idempotent merge)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = path.join(ROOT, "feedback", "inbox");
const argUrl = process.argv.indexOf("--url");
const BASE = argUrl > -1 ? process.argv[argUrl + 1] : "https://mailpulse-production.up.railway.app";
const TOKEN = process.env.MP_TOKEN || "";

const iso = (v) => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(typeof v === "object" && v.text ? v.text : v).trim();
  return s.slice(0, 10);
};
const txt = (v) => (v == null ? "" : String(typeof v === "object" && v.text ? v.text : v).trim());

async function readFileVerdicts(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file); // read-only: we never call write on this path
  const ws = wb.worksheets[0];
  const H = ws.getRow(1).values.slice(1).map((v) => String(v));
  const col = (n) => H.indexOf(n) + 1;
  if (col("Trigger Detail") === 0 || col("Status") === 0) {
    console.warn(`  SKIP ${path.basename(file)} — not a leads export (missing columns)`);
    return [];
  }
  const out = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const status = txt(r.getCell(col("Status")).value);
    if (!status) continue;
    out.push({
      queued_date: iso(r.getCell(col("Queued")).value),
      verified_email: txt(r.getCell(col("Verified Email")).value).toLowerCase(),
      company: txt(r.getCell(col("Company")).value),
      trigger_detail: txt(r.getCell(col("Trigger Detail")).value),
      status,
      rep_notes: col("Rep Notes") ? txt(r.getCell(col("Rep Notes")).value) : "",
      // Lead-tracker columns — present in exports since Jul 2026; older or
      // trimmed rep copies simply won't have them.
      sdr: col("SDR") ? txt(r.getCell(col("SDR")).value) : "",
      contacted_at: col("Contacted On") ? iso(r.getCell(col("Contacted On")).value) : "",
      response: col("Response") ? txt(r.getCell(col("Response")).value) : "",
      source: path.basename(file, path.extname(file)),
    });
  }
  return out;
}

function keyOf(v) {
  return [v.queued_date, v.verified_email || `#${v.company}`, v.trigger_detail].join("§");
}

async function main() {
  if (!TOKEN) {
    console.error("MP_TOKEN is not set — see the usage note at the top of this script.");
    process.exit(1);
  }
  if (!fs.existsSync(INBOX)) fs.mkdirSync(INBOX, { recursive: true });
  const files = fs.readdirSync(INBOX).filter((f) => f.toLowerCase().endsWith(".xlsx"));
  if (!files.length) {
    console.log(`Nothing to import — drop worked .xlsx files into ${INBOX}`);
    return;
  }

  console.log(`Reading ${files.length} worked file(s) from ${INBOX}\n`);
  const all = [];
  for (const f of files) {
    const vs = await readFileVerdicts(path.join(INBOX, f));
    console.log(`  ${f}: ${vs.length} row(s) with a status`);
    all.push(...vs);
  }

  // Cross-file conflict detection BEFORE sending: if two reps gave the same
  // lead different non-Pending verdicts, flag it and send neither.
  const byKey = new Map();
  for (const v of all) {
    const k = keyOf(v);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(v);
  }
  const winners = [];
  const fileConflicts = [];
  for (const [, group] of byKey) {
    const verdicts = group.filter((v) => v.status && v.status !== "Pending");
    const distinct = [...new Set(verdicts.map((v) => v.status))];
    if (distinct.length > 1) {
      fileConflicts.push(group);
    } else if (verdicts.length) {
      // Same verdict from 1+ reps → merge their notes; first non-empty wins
      // for the tracker fields.
      const w = { ...verdicts[0] };
      const notes = [...new Set(verdicts.map((v) => v.rep_notes).filter(Boolean))];
      w.rep_notes = notes.join(" | ");
      w.sdr = verdicts.map((v) => v.sdr).find(Boolean) || "";
      w.contacted_at = verdicts.map((v) => v.contacted_at).find(Boolean) || "";
      w.response = verdicts.map((v) => v.response).find(Boolean) || "";
      winners.push(w);
    }
  }

  console.log(`\n${winners.length} verdict(s) to merge, ${fileConflicts.length} cross-file conflict(s)`);

  const res = await fetch(`${BASE}/api/outbound/feedback`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verdicts: winners }),
  });
  if (!res.ok) {
    console.error(`Server error: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const report = await res.json();

  console.log(`\n=== IMPORT REPORT ===`);
  console.log(`updated   : ${report.updated}`);
  console.log(`unchanged : ${report.unchanged}`);
  console.log(`unmatched : ${report.unmatched.length}`);
  for (const u of report.unmatched.slice(0, 10)) {
    console.log(`   ? ${u.company} · ${u.verified_email || "(no email)"} · ${u.queued_date}`);
  }
  const dbConf = report.conflicts.length;
  if (fileConflicts.length || dbConf) {
    console.log(`\n*** CONFLICTS — need a human call, nothing was written for these ***`);
    for (const g of fileConflicts) {
      const v = g[0];
      console.log(
        `  BETWEEN FILES: ${v.company} (${v.verified_email || "no email"}) — ` +
          g.map((x) => `${x.source}=${x.status}`).join(" vs "),
      );
    }
    for (const c of report.conflicts) {
      console.log(
        `  VS DATABASE:  ${c.verdict.company} (${c.verdict.verified_email || "no email"}) — ` +
          `db=${c.db_status} vs ${c.verdict.source}=${c.verdict.status}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
