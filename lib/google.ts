import { JWT } from "google-auth-library";
import { getDb, getSetting } from "./db";
import { getFleetDomains, storeMessage, reclassifyWarmup } from "./inbox";

// Reads Google Workspace mailbox replies centrally via a service account with
// domain-wide delegation (Gmail API, read-only), impersonating each mailbox.
// Config: google_sa_json (the downloaded key file's contents) and optionally
// google_domains (comma list) to scope which mailboxes this workspace covers.

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

function b64urlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function extractText(payload: unknown): string {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | null;
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return b64urlDecode(p.body.data);
  if (p.parts) {
    for (const part of p.parts) {
      const t = extractText(part);
      if (t) return t;
    }
  }
  if (p.mimeType?.startsWith("text/") && p.body?.data) return b64urlDecode(p.body.data);
  return "";
}

function header(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseAddress(v: string): { email: string; name: string } {
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: v.trim().toLowerCase() };
}

export async function syncGoogleInbox(): Promise<string> {
  const db = getDb();
  const saRaw = getSetting("google_sa_json");
  if (!saRaw) return "Google not configured";
  let sa: { client_email: string; private_key: string };
  try {
    sa = JSON.parse(saRaw);
  } catch {
    return "Google service-account JSON is invalid";
  }

  const domainFilter = (getSetting("google_domains") ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  let mailboxes = (
    db.prepare("SELECT email, domain FROM senders WHERE provider = 'google'").all() as {
      email: string;
      domain: string;
    }[]
  ).map((r) => r.email.toLowerCase());
  if (domainFilter.length) {
    mailboxes = mailboxes.filter((e) => domainFilter.includes(e.split("@")[1] ?? ""));
  }
  if (mailboxes.length === 0) return "no Google mailboxes to read (check google_domains / provider)";

  const fleetDomains = getFleetDomains();
  const existing = new Set(
    (db.prepare("SELECT ext_id FROM inbox_messages WHERE source = 'google'").all() as { ext_id: string }[]).map(
      (r) => r.ext_id,
    ),
  );

  let stored = 0;
  let warmup = 0;
  let failed = 0;

  for (const mailbox of mailboxes) {
    try {
      const jwt = new JWT({ email: sa.client_email, key: sa.private_key, subject: mailbox, scopes: SCOPES });
      const { access_token } = await jwt.authorize();
      const auth = { Authorization: `Bearer ${access_token}` };
      const base = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(mailbox)}`;

      // Recent messages across Inbox + Spam (last 60 days).
      const listRes = await fetch(
        `${base}/messages?q=${encodeURIComponent("newer_than:60d (in:inbox OR in:spam)")}&maxResults=100`,
        { headers: auth },
      );
      if (!listRes.ok) {
        failed++;
        continue;
      }
      const list = (await listRes.json()) as { messages?: { id: string }[] };
      for (const { id } of list.messages ?? []) {
        if (existing.has(id)) continue;
        const msgRes = await fetch(`${base}/messages/${id}?format=full`, { headers: auth });
        if (!msgRes.ok) continue;
        const m = (await msgRes.json()) as {
          internalDate?: string;
          payload?: { headers?: { name: string; value: string }[] };
        };
        const headers = m.payload?.headers ?? [];
        const from = parseAddress(header(headers, "From"));
        const to = parseAddress(header(headers, "To"));
        const subject = header(headers, "Subject");
        const body = extractText(m.payload).trim();
        const date = m.internalDate
          ? new Date(Number(m.internalDate)).toISOString()
          : new Date().toISOString();

        const r = storeMessage({
          source: "google",
          extId: id,
          messageId: header(headers, "Message-ID") || null,
          fromEmail: from.email,
          fromName: from.name,
          toEmail: to.email || mailbox,
          subject,
          body,
          headers: headers.map((h) => `${h.name}: ${h.value}`).join("\n"),
          date,
          fleetDomains,
        });
        if (r === "stored") stored++;
        else if (r === "warmup") warmup++;
        existing.add(id);
      }
      await new Promise((res) => setTimeout(res, 120)); // gentle pacing per mailbox
    } catch {
      failed++;
    }
  }

  const recl = reclassifyWarmup();
  const msg = `Google: ${stored} new replies, ${warmup + recl} warmup filtered, ${mailboxes.length} mailboxes (${failed} failed)`;
  db.prepare("INSERT INTO sync_log (kind, ok, detail, finished_at) VALUES ('google-inbox', 1, ?, datetime('now'))").run(
    msg,
  );
  return msg;
}
