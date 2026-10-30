import { NextRequest, NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import { emailDigest, federalConfig, listOpen, runFederal, updateOpp } from "@/lib/federal";

// /api/federal — US Federal RFP agent (SAM.gov).
// GET   — open opportunities (ranked) + config/status. ?all=1 includes past-due.
// POST  — { action: "run" }            pull new opportunities now (no email)
//         { action: "email", to? }     email the ranked Excel now (test send)
//         { action: "settings", emailTo }  save the daily recipient list
// PATCH — { id, status?, notes? }      team triage on one opportunity

export async function GET(request: NextRequest) {
  const all = request.nextUrl.searchParams.get("all") === "1";
  return NextResponse.json({ rows: listOpen(all), config: federalConfig() });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { action?: string; to?: string; emailTo?: string };
  try {
    if (body.action === "run") {
      const report = await runFederal({ email: false });
      return NextResponse.json({ ok: true, report: { ...report, newIds: report.newIds.length } });
    }
    if (body.action === "email") return NextResponse.json({ ok: true, result: await emailDigest(null, body.to) });
    if (body.action === "settings") {
      setSetting("federal_email_to", (body.emailTo || "").trim());
      return NextResponse.json({ ok: true, config: federalConfig() });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { id?: string; status?: string; notes?: string };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    updateOpp(body.id, { status: body.status, notes: body.notes });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
