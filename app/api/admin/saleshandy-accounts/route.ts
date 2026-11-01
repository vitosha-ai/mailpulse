import { NextRequest, NextResponse } from "next/server";
import { listAllEmailAccounts } from "@/lib/saleshandy";

// Admin read (owner 2026-11-01): inventory of the Saleshandy account's
// mailboxes, for migrating them into Smartlead. Bearer auth like the other
// machine endpoints. Read-only.

export async function GET(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const accounts = await listAllEmailAccounts();
    return NextResponse.json({ count: accounts.length, accounts });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
