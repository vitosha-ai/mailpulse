import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";

const KEYS = [
  "instantly_api_key",
  "saleshandy_api_key",
  "smartlead_api_key",
  "trulyinbox_api_key",
  "spamhaus_dqs_key",
  "maildoso_api_key",
  "imap_host",
  "imap_port",
  "imap_user",
  "imap_pass",
] as const;

function mask(v: string | null): string | null {
  if (!v) return null;
  return v.length <= 8 ? "••••" : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

// Host/port/user aren't secrets — show them in full so they're easy to verify.
const PLAIN = new Set(["imap_host", "imap_port", "imap_user"]);

export async function GET() {
  const out: Record<string, string | null> = {};
  for (const k of KEYS) {
    const v = getSetting(k);
    out[k] = PLAIN.has(k) ? v : mask(v);
  }
  return NextResponse.json(out);
}

// POST { key, value } — save one setting. Empty value clears it.
export async function POST(request: NextRequest) {
  const { key, value } = (await request.json()) as { key: string; value: string };
  if (!KEYS.includes(key as (typeof KEYS)[number])) {
    return NextResponse.json({ error: "unknown setting" }, { status: 400 });
  }
  setSetting(key, (value ?? "").trim());
  return NextResponse.json({ ok: true });
}
