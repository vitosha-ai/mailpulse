import { NextResponse } from "next/server";
import { ImapFlow } from "imapflow";
import { getSetting } from "@/lib/db";

// TEMPORARY: discovers the master-inbox creds from Maildoso, then tries IMAP
// login against candidate hosts to find the working one. Remove after wiring.
export async function GET() {
  const token = getSetting("maildoso_api_key");
  if (!token) return NextResponse.json({ error: "no maildoso_api_key stored" });

  // 1) Master account creds from Maildoso.
  let user = "";
  let pass = "";
  try {
    const res = await fetch("https://api.maildoso.com/v1/user/forwarding-lookup?offset=0&limit=50", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await res.json();
    const master =
      (j.items ?? []).find((a: Record<string, unknown>) => a.assignment === "MASTER") ?? (j.items ?? [])[0];
    user = String(master?.email ?? "");
    pass = String(master?.password ?? "");
  } catch (e) {
    return NextResponse.json({ error: "forwarding-lookup failed", detail: String(e) });
  }
  if (!user || !pass) return NextResponse.json({ error: "no master creds found" });

  // 2) Try IMAP login against candidate hosts/ports.
  const hosts = [
    "mail.maildoso.email",
    "imap.maildoso.email",
    "_dc-mx.c5bbd1b0b133.maildoso.email",
    "185.221.223.123",
    "5.255.104.126",
    "mx.c5bbd1b0b133.maildoso.email",
  ];
  const ports = [993, 143];
  const out: Record<string, unknown>[] = [];

  for (const host of hosts) {
    for (const port of ports) {
      const client = new ImapFlow({
        host,
        port,
        secure: port === 993,
        auth: { user, pass },
        logger: false,
        // Short, tolerant — we're just probing reachability + login.
        socketTimeout: 8000,
        greetingTimeout: 6000,
        connectionTimeout: 6000,
        tls: { rejectUnauthorized: false },
      });
      try {
        await client.connect();
        const mbox = await client.status("INBOX", { messages: true });
        await client.logout();
        out.push({ host, port, result: "LOGIN OK", messages: mbox.messages });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.push({ host, port, result: msg.slice(0, 120) });
        try {
          await client.close();
        } catch {}
      }
    }
  }
  return NextResponse.json({ user, probes: out });
}
