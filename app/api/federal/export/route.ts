import { buildWorkbook, listOpen } from "@/lib/federal";

// GET /api/federal/export — the same ranked Excel the daily email attaches.
export async function GET() {
  const rows = listOpen();
  const today = new Date().toISOString().slice(0, 10);
  const fresh = new Set(rows.filter((r) => r.first_seen === today).map((r) => r.notice_id));
  const buf = await buildWorkbook(rows, fresh);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="Federal_RFPs_${today}.xlsx"`,
    },
  });
}
