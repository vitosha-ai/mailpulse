import ExcelJS from "exceljs";
import { getDb, getSetting, setSetting } from "./db";

// US Federal RFP agent. Once a day it pulls new SAM.gov opportunities through
// the Apify actor scrapesage/sam-gov-scraper (~$0.0025 per opportunity, no
// SAM.gov key needed), keeps only ones Vitosha can bid on (small business,
// no SBA certifications), scores each for fit with Vitosha's IT-services work,
// stores them, and emails the ranked list as an Excel attachment.

const ACTOR = "scrapesage~sam-gov-scraper";
const NAICS = ["5415", "561320", "541612"]; // IT services, temp staffing, HR consulting
const NOTICE_TYPES = ["o", "k", "r", "p"]; // solicitation, combined, sources sought, presolicitation
// Vitosha = small business, no 8(a)/WOSB/HUBZone/SDVOSB/Native certifications.
const ELIGIBLE_SET_ASIDES = new Set(["", "NONE", "SBA", "SBP"]);
const MIN_DAYS_TO_DUE = 3;

export const FED_STATUSES = ["New", "Reviewing", "Go", "No Bid", "Submitted"] as const;

export type FedOpp = {
  notice_id: string;
  title: string;
  notice_type: string;
  solicitation_no: string;
  agency: string;
  sub_agency: string;
  office: string;
  set_aside: string;
  naics: string;
  psc: string;
  psc_title: string;
  posted_date: string;
  due_date: string;
  state: string;
  place: string;
  co_name: string;
  co_email: string;
  co_phone: string;
  attachments: number;
  url: string;
  score: number;
  tier: "Strong" | "Maybe" | "Low";
  why: string;
  clearance: string;
  tags: string;
  status: string;
  notes: string;
  first_seen: string;
  updated_at: string;
};

function ensureTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS federal_opps (
      notice_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      notice_type TEXT NOT NULL DEFAULT '',
      solicitation_no TEXT NOT NULL DEFAULT '',
      agency TEXT NOT NULL DEFAULT '',
      sub_agency TEXT NOT NULL DEFAULT '',
      office TEXT NOT NULL DEFAULT '',
      set_aside TEXT NOT NULL DEFAULT '',
      naics TEXT NOT NULL DEFAULT '',
      psc TEXT NOT NULL DEFAULT '',
      psc_title TEXT NOT NULL DEFAULT '',
      posted_date TEXT NOT NULL DEFAULT '',
      due_date TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      place TEXT NOT NULL DEFAULT '',
      co_name TEXT NOT NULL DEFAULT '',
      co_email TEXT NOT NULL DEFAULT '',
      co_phone TEXT NOT NULL DEFAULT '',
      attachments INTEGER NOT NULL DEFAULT 0,
      url TEXT NOT NULL DEFAULT '',
      score INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'Low',
      why TEXT NOT NULL DEFAULT '',
      clearance TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'New',
      notes TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT (date('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fed_due ON federal_opps(due_date);
    CREATE INDEX IF NOT EXISTS idx_fed_score ON federal_opps(score);
  `);
}

// ---------------------------------------------------------------------------
// Fit scoring. Plain rules so the team can read "why" on every row.

const STRONG: RegExp[] = [
  /software (development|engineering|coding)/i, /application (development|integration)/i, /\bapps? dev/i,
  /\bdata\b/i, /analytic/i, /data science/i, /\bcloud\b/i, /migration/i, /moderniz/i, /integrat/i,
  /system integrator/i, /\bERP\b/i, /help ?desk/i, /service desk/i, /sustainment/i, /IT support/i,
  /devops/i, /agile/i, /\bAI\b/, /artificial intelligence/i, /machine learning/i, /servicenow/i,
  /power platform/i, /databricks/i, /\bfabric\b/i, /\bweb\b/i, /digital/i, /staff augmentation/i,
  /technical services/i, /program support/i, /support services/i, /replacement/i, /case management/i,
  /mobile application/i, /onestream/i, /\bSAS\b/, /dynamics 365|\bD365\b/i, /salesforce (implementation|development)/i,
];
const NEGATIVE: RegExp[] = [
  /licen[cs]e/i, /subscription/i, /renewal/i, /brand name/i, /hardware/i, /printer/i, /scanner/i,
  /terminals/i, /\bdrops\b/i, /valve/i, /piston/i, /tape library/i, /mainframe/i, /timeserver/i,
  /physician/i, /\bEMT\b/, /paramedic/i, /midwi/i, /mental health/i, /orthopedic/i, /transportation services/i,
  /weapon/i, /simulator/i, /training devices?/i, /air operations/i, /\bC2\b/, /aircraft/i, /GEOINT/i,
  /access cards/i, /electronic security system/i, /biology testing/i, /nurse call/i, /technician support/i,
  /sole source/i, /wireless network/i, /3d laser/i, /dose monitor/i, /television/i,
  /cyberspace/i, /pilot training/i, /video intelligence/i, /prototype/i, /installation and training/i,
  /sizing technology/i, /geospatial/i, /air defense/i, /naval/i, /\bUAS\b/,
];
const CLEAR_HARD = /facility (security )?clearance|\bFCL\b|DD[ -]?(Form )?254|top secret|TS\/SCI|secret clearance/i;
const CLEAR_SOFT = /public trust|u\.?s\.? citizens? only|security clearance/i;
const BIG_VEHICLE = /\bGWAC\b|alliant|polaris|\bIDIQ\b/i;

const label = (re: RegExp) => {
  const w = re.source.replace(/\\b|[\\?]/g, "").replace(/\(([^|)]*)[^)]*\)/g, "$1").replace(/[()]/g, "").split("|")[0];
  return ({ moderniz: "modernization", analytic: "analytics", integrat: "integration" } as Record<string, string>)[w] ?? w;
};

function pscPoints(psc: string): [number, string] {
  const p = psc.toUpperCase();
  if (/^D[A-Z]0[1-9]$/.test(p)) return [40, "IT labor service code"];
  if (["R408", "R499", "B544", "R612", "U012"].includes(p)) return [20, "Professional services code"];
  if (p === "R425") return [10, "Engineering/technical code"];
  if (/^D[A-Z]1\d$/.test(p)) return [15, "IT 'as a service' code (often software)"];
  if (!p) return [15, "No service code"];
  return [0, "Product/hardware/non-IT code"];
}

type Raw = Record<string, unknown> & {
  noticeId?: string; title?: string; noticeType?: string; solicitationNumber?: string;
  department?: string; subTier?: string; office?: string; setAside?: string; setAsideCode?: string;
  primaryNaicsCode?: string; pscCode?: string; pscTitle?: string; postedDate?: string;
  responseDeadline?: string; descriptionText?: string; url?: string;
  primaryContactName?: string; primaryContactEmail?: string; primaryContactPhone?: string;
  attachmentsCount?: number; attachments?: { name?: string }[];
  placeOfPerformance?: { state?: string } | null; placeOfPerformanceText?: string;
  officeAddress?: { state?: string } | null;
};

export function scoreOpp(x: Raw) {
  const title = x.title || "";
  const desc = x.descriptionText || "";
  const attNames = (x.attachments || []).map((a) => a.name || "").join(" ");
  const psc = x.pscCode || "";
  const why: string[] = [];

  const [p, pl] = pscPoints(psc);
  let score = p;
  why.push(`${pl} (${psc || "-"})`);

  const inTitle = STRONG.filter((r) => r.test(title));
  const inDesc = STRONG.filter((r) => !inTitle.includes(r) && r.test(desc.slice(0, 1500)));
  score += Math.min(45, 15 * inTitle.length) + Math.min(15, 5 * inDesc.length);
  if (inTitle.length + inDesc.length) {
    why.push("IT-services words: " + [...inTitle, ...inDesc].slice(0, 4).map(label).join(", "));
  }
  if (NEGATIVE.some((r) => r.test(title))) {
    score -= 40;
    why.push("Product/off-target words in title");
  }
  const openBid = x.noticeType === "Solicitation" || x.noticeType === "Combined Synopsis/Solicitation";
  score += openBid ? 10 : 5;
  if (openBid) why.push("Open bid");

  let clearance = "";
  if (CLEAR_HARD.test(desc) || /\b254\b/.test(attNames)) {
    clearance = "Needs facility clearance - skip";
    score -= 30;
  } else if (CLEAR_SOFT.test(desc)) clearance = "Citizen/public-trust staff";
  else if ((x.department || "").startsWith("DEPT OF DEFENSE")) clearance = "Check clearance (Defense)";

  const tags: string[] = [];
  if (BIG_VEHICLE.test(title)) tags.push("Big contract vehicle");
  if (desc.length < 300) tags.push("Details in attachments");

  score = Math.max(0, Math.min(100, score));
  const tier: FedOpp["tier"] = score >= 60 ? "Strong" : score >= 35 ? "Maybe" : "Low";
  return { score, tier, why: why.join("; "), clearance, tags: tags.join(", ") };
}

const cleanName = (n?: string) => {
  const s = (n || "").trim();
  return /^[\d\-()\s.]+$/.test(s) ? "" : s;
};

function dayPlus(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Pull + store.

export function apifyToken() {
  return process.env.APIFY_TOKEN || getSetting("apify_token") || "";
}

async function pullFromSam(postedFrom: string): Promise<Raw[]> {
  const token = apifyToken();
  if (!token) throw new Error("APIFY_TOKEN not configured");
  const input = {
    naicsCodes: NAICS,
    noticeTypes: NOTICE_TYPES,
    status: "active",
    postedFrom,
    maxResults: 400,
    sortBy: "-modifiedDate",
    fetchFullDetails: true,
    includeAttachments: true,
    downloadAttachments: false,
  };
  const r = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?maxTotalChargeUsd=2&timeout=280`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!r.ok) throw new Error(`Apify ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as Raw[];
}

export type FedRunReport = {
  pulled: number;
  ineligible: number;
  tooLate: number;
  inserted: number;
  updated: number;
  newIds: string[];
  emailed: string | null;
};

export async function runFederal(opts: { email?: boolean; postedFrom?: string } = {}): Promise<FedRunReport> {
  ensureTables();
  const db = getDb();
  const empty = (db.prepare("SELECT COUNT(*) n FROM federal_opps").get() as { n: number }).n === 0;
  // First run backfills a month; daily runs overlap 3 days so nothing slips.
  const items = await pullFromSam(opts.postedFrom || (empty ? "30 days" : "3 days"));
  const cutoff = dayPlus(MIN_DAYS_TO_DUE);
  const report: FedRunReport = { pulled: items.length, ineligible: 0, tooLate: 0, inserted: 0, updated: 0, newIds: [], emailed: null };

  const exists = db.prepare("SELECT 1 FROM federal_opps WHERE notice_id = ?");
  // SAM.gov posts amendments under a NEW notice id with the same solicitation
  // number. Fold those into the existing row so the team never sees a repeat.
  const sameSolicitation = db.prepare(
    "SELECT notice_id FROM federal_opps WHERE solicitation_no = ? AND solicitation_no <> '' AND notice_id <> ? LIMIT 1",
  );
  // Oldest first, so when one batch holds the original and its amendment the
  // amendment's details are written last.
  items.sort((a, b) => String(a.postedDate || "").localeCompare(String(b.postedDate || "")));
  const upsert = db.prepare(`
    INSERT INTO federal_opps (notice_id, title, notice_type, solicitation_no, agency, sub_agency, office,
      set_aside, naics, psc, psc_title, posted_date, due_date, state, place, co_name, co_email, co_phone,
      attachments, url, score, tier, why, clearance, tags)
    VALUES (@notice_id, @title, @notice_type, @solicitation_no, @agency, @sub_agency, @office,
      @set_aside, @naics, @psc, @psc_title, @posted_date, @due_date, @state, @place, @co_name, @co_email, @co_phone,
      @attachments, @url, @score, @tier, @why, @clearance, @tags)
    ON CONFLICT(notice_id) DO UPDATE SET
      title = excluded.title, notice_type = excluded.notice_type, due_date = excluded.due_date,
      set_aside = excluded.set_aside, co_name = excluded.co_name, co_email = excluded.co_email,
      co_phone = excluded.co_phone, attachments = excluded.attachments, score = excluded.score,
      tier = excluded.tier, why = excluded.why, clearance = excluded.clearance,
      url = excluded.url, posted_date = excluded.posted_date,
      tags = CASE WHEN @amended = 1 THEN trim(excluded.tags || ', Amended', ', ') ELSE excluded.tags END,
      updated_at = datetime('now')`);

  db.transaction(() => {
    for (const x of items) {
      if (!x.noticeId) continue;
      if (!ELIGIBLE_SET_ASIDES.has((x.setAsideCode || "").toUpperCase())) { report.ineligible++; continue; }
      const due = (x.responseDeadline || "").slice(0, 10);
      if (due && due < cutoff) { report.tooLate++; continue; }
      const s = scoreOpp(x);
      const original = x.solicitationNumber
        ? (sameSolicitation.get(x.solicitationNumber, x.noticeId) as { notice_id: string } | undefined)
        : undefined;
      const id = original?.notice_id ?? x.noticeId;
      const isNew = !exists.get(id);
      upsert.run({
        amended: original ? 1 : 0,
        notice_id: id,
        title: x.title || "",
        notice_type: x.noticeType || "",
        solicitation_no: x.solicitationNumber || "",
        agency: x.department || "",
        sub_agency: x.subTier || "",
        office: x.office || "",
        set_aside: x.setAside || "None",
        naics: x.primaryNaicsCode || "",
        psc: x.pscCode || "",
        psc_title: x.pscTitle || "",
        posted_date: (x.postedDate || "").slice(0, 10),
        due_date: due,
        state: x.placeOfPerformance?.state || x.officeAddress?.state || "",
        place: x.placeOfPerformanceText || "",
        co_name: cleanName(x.primaryContactName),
        co_email: x.primaryContactEmail || "",
        co_phone: x.primaryContactPhone || "",
        attachments: x.attachmentsCount || 0,
        url: x.url || "",
        ...s,
      });
      if (isNew) { report.inserted++; report.newIds.push(id); } else report.updated++;
    }
  })();

  setSetting("federal_last_run", new Date().toISOString());
  setSetting("federal_last_report", JSON.stringify({ ...report, newIds: report.newIds.length }));

  // Every morning gets an email: the new ones as Excel, or a short
  // "nothing new today" note so the team knows the agent ran.
  if (opts.email) {
    report.emailed = await emailDigest(report.newIds);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Read, Excel, email.

export function listOpen(includeClosed = false): FedOpp[] {
  ensureTables();
  const today = new Date().toISOString().slice(0, 10);
  return getDb()
    .prepare(
      `SELECT * FROM federal_opps
        WHERE ? OR due_date = '' OR due_date >= ?
        ORDER BY score DESC, CASE WHEN due_date = '' THEN '9999' ELSE due_date END ASC`,
    )
    .all(includeClosed ? 1 : 0, today) as FedOpp[];
}

export function updateOpp(id: string, patch: { status?: string; notes?: string }) {
  ensureTables();
  if (patch.status && !(FED_STATUSES as readonly string[]).includes(patch.status)) throw new Error("bad status");
  const db = getDb();
  if (patch.status !== undefined) db.prepare("UPDATE federal_opps SET status = ?, updated_at = datetime('now') WHERE notice_id = ?").run(patch.status, id);
  if (patch.notes !== undefined) db.prepare("UPDATE federal_opps SET notes = ?, updated_at = datetime('now') WHERE notice_id = ?").run(patch.notes, id);
}

export async function buildWorkbook(rows: FedOpp[], newIds: Set<string>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const counts = { Strong: 0, Maybe: 0, Low: 0 } as Record<string, number>;
  rows.forEach((r) => counts[r.tier]++);

  const sm = wb.addWorksheet("Summary");
  const lines: [string, string | number][] = [
    ["SAM.gov federal opportunities - fit-ranked", ""],
    ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"],
    ["What's included", "Open opportunities Vitosha can bid on (no set-aside, or small-business set-aside), due in 3+ days"],
    ["NAICS searched", "5415xx IT services, 561320 temp staffing, 541612 HR consulting"],
    ["Opportunities in this file", rows.length],
    ["  of which new (never sent before)", rows.filter((r) => newIds.has(r.notice_id)).length],
    ["  Strong fit (60+)", counts.Strong],
    ["  Maybe (35-59)", counts.Maybe],
    ["  Low (under 35)", counts.Low],
    ["", ""],
    ["How the score works", ""],
    ["Service code", "+40 IT labor (DA01, DD01, DE01...); +20 professional services; +15 'as a service' or no code; 0 products/hardware/medical"],
    ["IT-services words", "+15 each in title (max 45), +5 each in description (max 15): software development, data, cloud, integration, ERP, help desk..."],
    ["Off-target words", "-40 if the title says license, subscription, renewal, hardware, brand name, physician, weapon, simulator..."],
    ["Notice type", "+10 open bid (Solicitation / Combined), +5 Sources Sought / Presolicitation"],
    ["Clearance", "-30 if the description or attachment names mention facility clearance / DD-254 / Secret / TS. Defense items tagged 'Check clearance'."],
  ];
  lines.forEach(([a, b], i) => {
    const row = sm.addRow([a, b]);
    if (i === 0 || a === "How the score works") row.font = { bold: true };
  });
  sm.getColumn(1).width = 30;
  sm.getColumn(2).width = 110;

  const ws = wb.addWorksheet("Ranked opportunities", { views: [{ state: "frozen", xSplit: 4, ySplit: 1 }] });
  const cols: [string, number][] = [
    ["Rank", 6], ["Fit", 9], ["Score", 7], ["Title", 60], ["New", 6], ["Notice type", 18], ["Due", 11],
    ["Agency", 28], ["Sub-agency", 28], ["Set-aside", 22], ["NAICS", 9], ["Service code", 10],
    ["Clearance", 24], ["Tags", 24], ["Contracting officer", 22], ["Email", 30], ["Phone", 15],
    ["State", 7], ["Posted", 11], ["Solicitation #", 22], ["Attachments", 11], ["Status", 11], ["Why this score", 60], ["SAM.gov link", 14],
  ];
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
  const fills: Record<string, string> = { Strong: "FFC6EFCE", Maybe: "FFFFEB9C", Low: "FFF2F2F2" };
  rows.forEach((r, i) => {
    const row = ws.addRow([
      i + 1, r.tier, r.score, r.title, newIds.has(r.notice_id) ? "NEW" : "", r.notice_type, r.due_date,
      r.agency, r.sub_agency, r.set_aside, r.naics, r.psc, r.clearance, r.tags, r.co_name, r.co_email,
      r.co_phone, r.state, r.posted_date, r.solicitation_no, r.attachments, r.status, r.why,
      r.url ? { text: "Open", hyperlink: r.url } : "",
    ]);
    row.alignment = { vertical: "top" };
    row.getCell(4).alignment = { vertical: "top", wrapText: true };
    row.getCell(23).alignment = { vertical: "top", wrapText: true };
    row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fills[r.tier] } };
    row.getCell(24).font = { color: { argb: "FF0563C1" }, underline: true };
    if (r.clearance.startsWith("Needs")) row.getCell(13).font = { color: { argb: "FFC00000" }, bold: true };
    if (newIds.has(r.notice_id)) row.getCell(5).font = { bold: true, color: { argb: "FF0B40B0" } };
  });
  ws.autoFilter = { from: "A1", to: { row: rows.length + 1, column: cols.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function emailDigest(newIds: string[] | null, toOverride?: string): Promise<string> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return "RESEND_API_KEY not configured";
  const to = (toOverride || emailRecipients()).split(/[,;\s]+/).filter(Boolean);
  if (to.length === 0) return "No recipient set (federal_email_to)";

  const rows = listOpen();
  const fresh = new Set(newIds ?? []);
  const newRows = rows.filter((r) => fresh.has(r.notice_id));
  const highlight = (newIds ? newRows : rows).filter((r) => r.tier !== "Low").slice(0, 10);
  // Daily email = only opportunities never sent before (no day-to-day repeats).
  // A manual test send has no "new" set, so it carries everything open.
  const xlsx = await buildWorkbook(newIds ? newRows : rows, fresh);
  const date = new Date().toISOString().slice(0, 10);
  const strongNew = newRows.filter((r) => r.tier === "Strong").length;

  const quiet = newIds !== null && newRows.length === 0;
  const strongOpen = rows.filter((r) => r.tier === "Strong" && r.status !== "No Bid").length;
  const subject = quiet
    ? `Federal RFPs ${date}: no new opportunities today`
    : newIds
      ? `Federal RFPs ${date}: ${newRows.length} new (${strongNew} strong fit)`
      : `Federal RFPs ${date}: ${rows.length} open opportunities (test)`;
  const list = highlight
    .map(
      (r) =>
        `<tr><td style="padding:4px 8px"><b>${r.tier}</b> ${r.score}</td>` +
        `<td style="padding:4px 8px"><a href="${esc(r.url)}">${esc(r.title)}</a><br><span style="color:#64748b;font-size:12px">${esc(r.sub_agency || r.agency)} · due ${r.due_date || "n/a"}${r.clearance ? " · " + esc(r.clearance) : ""}</span></td></tr>`,
    )
    .join("");
  const quietHtml =
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a">` +
    `<p>No new federal opportunities on SAM.gov since yesterday's email.</p>` +
    `<p>${rows.length} are still open that Vitosha can bid on (${strongOpen} strong fit). They're on the US Federal RFPs board in MailPulse, and were in earlier emails.</p>` +
    `<p style="color:#64748b;font-size:12px">— MailPulse · US Federal agent</p></div>`;
  const html = quiet ? quietHtml :
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a">` +
    `<p>${newIds ? `${newRows.length} new federal opportunities since the last run.` : "Test send of the federal RFP feed."} ` +
    `${rows.length} open in total that Vitosha can bid on. The full ranked list is attached.</p>` +
    (list ? `<p><b>Top ${newIds ? "new " : ""}matches</b></p><table style="border-collapse:collapse">${list}</table>` : "") +
    `<p style="color:#64748b;font-size:12px">Source: SAM.gov, IT services / temp staffing / HR consulting NAICS. Set-asides for certified groups and items due within 3 days are left out. Check the attachments before choosing Go: clearance needs are often only in the PDFs.</p>` +
    `<p style="color:#64748b;font-size:12px">— MailPulse · US Federal agent</p></div>`;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.FEDERAL_EMAIL_FROM || "MailPulse Federal RFPs <no-reply@vitosha-inc.com>",
      to,
      subject,
      html,
      ...(quiet ? {} : { attachments: [{ filename: `Federal_RFPs_${date}.xlsx`, content: xlsx.toString("base64") }] }),
    }),
  });
  if (!r.ok) return `Resend ${r.status}: ${(await r.text()).slice(0, 200)}`;
  setSetting("federal_last_email", new Date().toISOString());
  return `sent to ${to.join(", ")}`;
}

// Default daily recipients (owner's choice 2026-10-30); editable on the board's ⚙.
const DEFAULT_RECIPIENTS = "proposals@vitoshainc.com, ajay@vitoshainc.com";
function emailRecipients() {
  return getSetting("federal_email_to") || DEFAULT_RECIPIENTS;
}

export function federalConfig() {
  return {
    apify: Boolean(apifyToken()),
    resend: Boolean(process.env.RESEND_API_KEY),
    emailTo: emailRecipients(),
    lastRun: getSetting("federal_last_run"),
    lastReport: getSetting("federal_last_report"),
    lastEmail: getSetting("federal_last_email"),
  };
}
