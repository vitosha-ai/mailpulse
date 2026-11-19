import { buildWorkbook, listOpen } from "@/lib/sled";

// GET /api/sled/export — every open Strong/Maybe SLED opportunity as Excel.
export async function GET() {
  const rows = listOpen();
  const today = new Date().toISOString().slice(0, 10);
  const fresh = new Set(rows.filter((r) => r.first_seen === today).map((r) => r.id));
  const buf = await buildWorkbook(rows, fresh);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="State_Local_RFPs_${today}.xlsx"`,
    },
  });
}
