import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { pickSendersForTest, startPlacementBatch, pollPlacementTests } from "@/lib/placement";
import { rescoreAll } from "@/lib/sync";

export async function GET() {
  // Poll running tests first so the list is fresh, then return recent tests.
  const polled = await pollPlacementTests().catch((e) => `poll failed: ${e.message ?? e}`);
  const tests = getDb()
    .prepare("SELECT id, instantly_test_id, name, status, emails, created_at, completed_at FROM placement_tests ORDER BY id DESC LIMIT 20")
    .all() as Record<string, unknown>[];
  return NextResponse.json({
    polled,
    tests: tests.map((t) => ({ ...t, emails: JSON.parse(t.emails as string).length })),
  });
}

// POST { batchSize?: number, emails?: string[] } — start a placement test.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { batchSize?: number; emails?: string[] };
  const emails =
    body.emails && body.emails.length > 0
      ? body.emails.map((e) => e.toLowerCase())
      : pickSendersForTest(body.batchSize ?? 50);
  if (emails.length === 0) {
    return NextResponse.json({ error: "no active senders to test" }, { status: 400 });
  }
  const id = await startPlacementBatch(emails);
  rescoreAll();
  return NextResponse.json({ ok: true, testId: id, senders: emails.length });
}
