import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getDb } from "@/lib/db";

// GET /api/outbound/export — download leads as .xlsx (or .csv).
// Scope params (pick one):
//   date=YYYY-MM-DD                    one day
//   from=YYYY-MM-DD&to=YYYY-MM-DD      inclusive date range
//   (neither)                          all days
// Optional filters (match the Outbound page's view):
//   status, trigger, conf (comma list), q (text), nopoc=1
//   format=xlsx (default) | csv
// Sits behind the password gate (proxy.ts) like the rest of the app.

const COLS: { key: string; header: string; width: number }[] = [
  { key: "queued_date", header: "Queued", width: 11 },
  { key: "first_name", header: "First Name", width: 12 },
  { key: "last_name", header: "Last Name", width: 12 },
  { key: "title", header: "Title", width: 26 },
  { key: "verified_email", header: "Verified Email", width: 28 },
  { key: "linkedin", header: "LinkedIn", width: 30 },
  { key: "company", header: "Company", width: 24 },
  { key: "size", header: "Size (emp)", width: 10 },
  { key: "trigger_type", header: "Trigger Type", width: 14 },
  { key: "trigger_detail", header: "Trigger Detail", width: 46 },
  { key: "trigger_date", header: "Trigger Date", width: 11 },
  { key: "source_url", header: "Source URL", width: 34 },
  { key: "bucket", header: "Bucket", width: 16 },
  { key: "pillar", header: "Pillar", width: 18 },
  { key: "proof_point", header: "Proof Point", width: 18 },
  { key: "detected_stack", header: "Detected Stack", width: 16 },
  { key: "confidence", header: "Confidence", width: 11 },
  { key: "status", header: "Status", width: 11 },
  { key: "subject", header: "Subject", width: 30 },
  { key: "email_1", header: "Email 1", width: 55 },
  { key: "followup_day_3", header: "Follow-up Day 3", width: 45 },
  { key: "followup_day_8", header: "Follow-up Day 8", width: 45 },
  { key: "breakup_day_15", header: "Breakup Day 15", width: 40 },
  { key: "rep_notes", header: "Rep Notes", width: 30 },
  { key: "fit_reason", header: "Fit Justification", width: 50 },
  { key: "research_trail", header: "Research Trail", width: 60 },
  { key: "researched_at", header: "Researched At", width: 18 },
  { key: "market", header: "Market", width: 8 },
];

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const date = sp.get("date");
  const from = sp.get("from");
  const to = sp.get("to");
  const status = sp.get("status");
  const trigger = sp.get("trigger");
  const conf = sp.get("conf"); // comma-separated High,Medium,Low
  const q = sp.get("q");
  const nopoc = sp.get("nopoc");
  const market = sp.get("market");
  const format = sp.get("format") === "csv" ? "csv" : "xlsx";

  const where: string[] = [];
  const params: unknown[] = [];
  let scopeName = "all-days";
  if (date) {
    where.push("queued_date = ?");
    params.push(date);
    scopeName = date;
  } else if (from && to) {
    where.push("queued_date >= ? AND queued_date <= ?");
    params.push(from, to);
    scopeName = `${from}_to_${to}`;
  } else if (from) {
    where.push("queued_date >= ?");
    params.push(from);
    scopeName = `since_${from}`;
  }
  if (market) {
    where.push("COALESCE(market,'us') = ?");
    params.push(market);
    scopeName = `${market}-${scopeName}`;
  }
  if (status) {
    const list = status.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) {
      where.push(`status IN (${list.map(() => "?").join(",")})`);
      params.push(...list);
    }
  }
  if (trigger) {
    const list = trigger.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) {
      where.push(`trigger_type IN (${list.map(() => "?").join(",")})`);
      params.push(...list);
    }
  }
  if (conf) {
    const levels = conf.split(",").map((s) => s.trim()).filter(Boolean);
    if (levels.length) {
      where.push(`COALESCE(confidence,'Low') IN (${levels.map(() => "?").join(",")})`);
      params.push(...levels);
    }
  }
  if (nopoc === "1") where.push("COALESCE(first_name,'') = '' AND COALESCE(verified_email,'') = ''");
  if (q) {
    where.push("(company LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR title LIKE ? OR verified_email LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  const rows = getDb()
    .prepare(
      `SELECT * FROM research_queue
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY queued_date DESC,
                CASE COALESCE(confidence,'Low') WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
                company, id`,
    )
    .all(...params) as Record<string, unknown>[];

  const stamp = new Date().toISOString().slice(0, 10);
  const base = `vitosha-leads-${scopeName || stamp}`;

  if (format === "csv") {
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      COLS.map((c) => esc(c.header)).join(","),
      ...rows.map((r) => COLS.map((c) => esc(r[c.key])).join(",")),
    ];
    // UTF-8 BOM so Excel opens it with correct encoding on double-click.
    const csv = "﻿" + lines.join("\r\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.csv"`,
      },
    });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "MailPulse — Vitosha research agent";
  const ws = wb.addWorksheet("Leads", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLS.map((c) => ({ key: c.key, width: c.width }));

  const header = ws.addRow(COLS.map((c) => c.header));
  header.font = { name: "Arial", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 24;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3A4A5E" } };
  });

  for (const r of rows) {
    const row = ws.addRow(COLS.map((c) => (r[c.key] == null ? "" : String(r[c.key]))));
    row.font = { name: "Arial", size: 9 };
    row.alignment = { vertical: "top", wrapText: true };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLS.length } };

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${base}.xlsx"`,
    },
  });
}
