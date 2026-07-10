import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getDb, getSetting } from "./db";
import { discoverMasterInboxImap } from "./maildoso";

// Reads the Maildoso master inbox over IMAP, filters out warmup traffic, and
// stores real prospect replies. Credentials come either from the manual IMAP
// fields or are auto-discovered from a Maildoso API token.

async function imapConfig() {
  let host = getSetting("imap_host");
  let user = getSetting("imap_user");
  let pass = getSetting("imap_pass");
  let port = Number(getSetting("imap_port") ?? "993");
  if (!host || !user || !pass) {
    // Try to auto-discover from the Maildoso API token.
    const creds = await discoverMasterInboxImap();
    if (creds) {
      host = creds.host;
      user = creds.user;
      pass = creds.pass;
      port = creds.port;
    }
  }
  if (!host || !user || !pass) return null;
  return { host, port, secure: port === 993, auth: { user, pass }, logger: false as const };
}

// A message is warmup noise if it carries a known warmup marker or comes from
// a mailbox that belongs to our own fleet (warmup network chatter). Instantly
// stamps warmup mail with an identifier in the body/subject/headers.
function isWarmupMessage(input: {
  subject: string;
  body: string;
  headers: string;
  fromEmail: string;
  fleetDomains: Set<string>;
}): boolean {
  const hay = `${input.subject}\n${input.headers}`.toLowerCase();
  // Instantly + common warmup fingerprints.
  const markers = [
    "x-instantly", // Instantly injects x-instantly-* headers
    "instantly-warmup",
    "ipwarmup",
    "warmup",
    "x-warmup",
    "emailwarmup",
    "mailwarm",
    "x-tw-", // TrulyInbox / warmup tags
  ];
  if (markers.some((m) => hay.includes(m))) return true;
  // A random alphanumeric "warmup code" often appears alone on a line in the body.
  if (/\bwarm[\s-]?up\b/i.test(input.subject)) return true;
  // Reply came from one of our own sending domains → warmup-network chatter,
  // not a prospect.
  const fromDomain = input.fromEmail.split("@")[1]?.toLowerCase() ?? "";
  if (fromDomain && input.fleetDomains.has(fromDomain)) return true;
  return false;
}

// Lightweight intent classifier for real replies.
export function categorize(subject: string, body: string): string {
  const t = `${subject} ${body}`.toLowerCase();
  if (/\bout of (the )?office\b|\bon (leave|vacation|holiday|pto)\b|automatic reply|auto[- ]?reply|away from my (desk|email)/.test(t))
    return "out-of-office";
  if (/\bunsubscrib|\bremove me\b|\bopt[- ]?out\b|\bstop emailing\b|\btake me off\b|\bdo not (contact|email)\b/.test(t))
    return "unsubscribe";
  if (/\b(interested|sounds good|let'?s (talk|chat|connect)|book a (call|time|meeting)|schedule|tell me more|how much|pricing|send (me )?(more|info|details)|happy to|keen|yes[.,! ])/.test(t))
    return "interested";
  if (/mailer-daemon|delivery (status|has failed)|undeliverable|failure notice|postmaster/.test(t))
    return "auto-reply";
  return "other";
}

export async function syncInbox(): Promise<string> {
  const db = getDb();
  const cfg = await imapConfig();
  if (!cfg) return "Master inbox not configured — add a Maildoso API key or IMAP details in Settings";

  const fleetDomains = new Set(
    (db.prepare("SELECT DISTINCT domain FROM senders WHERE domain != ''").all() as { domain: string }[]).map(
      (r) => r.domain.toLowerCase(),
    ),
  );

  const client = new ImapFlow(cfg);
  let stored = 0;
  let warmupSkipped = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Highest UID we already have — only fetch newer messages.
      const maxRow = db.prepare("SELECT MAX(uid) AS m FROM inbox_messages").get() as { m: number | null };
      const since = (maxRow.m ?? 0) + 1;

      const insert = db.prepare(`
        INSERT INTO inbox_messages
          (uid, message_id, from_email, from_name, to_email, subject, preview, body, received_at, category, is_warmup, seen)
        VALUES (@uid, @message_id, @from_email, @from_name, @to_email, @subject, @preview, @body, @received_at, @category, @is_warmup, 0)
        ON CONFLICT(uid) DO NOTHING
      `);

      // Fetch source for new UIDs; range "since:*" grabs everything newer.
      for await (const msg of client.fetch(`${since}:*`, { uid: true, source: true })) {
        const parsed = await simpleParser(msg.source as Buffer);
        const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase() ?? "";
        const fromName = parsed.from?.value?.[0]?.name ?? "";
        const toEmail =
          (Array.isArray(parsed.to) ? parsed.to[0] : parsed.to)?.value?.[0]?.address?.toLowerCase() ?? "";
        const subject = parsed.subject ?? "";
        const body = (parsed.text ?? "").trim();
        const headers = [...(parsed.headerLines ?? [])].map((h) => h.line).join("\n");

        const warmup = isWarmupMessage({ subject, body, headers, fromEmail, fleetDomains });
        if (warmup) {
          warmupSkipped++;
          // Record minimally so we don't re-fetch, but flagged and hidden.
          insert.run({
            uid: Number(msg.uid),
            message_id: parsed.messageId ?? null,
            from_email: fromEmail,
            from_name: fromName,
            to_email: toEmail,
            subject: subject.slice(0, 200),
            preview: null,
            body: null,
            received_at: (parsed.date ?? new Date()).toISOString(),
            category: null,
            is_warmup: 1,
          });
          continue;
        }

        insert.run({
          uid: Number(msg.uid),
          message_id: parsed.messageId ?? null,
          from_email: fromEmail,
          from_name: fromName,
          to_email: toEmail,
          subject,
          preview: body.slice(0, 300),
          body,
          received_at: (parsed.date ?? new Date()).toISOString(),
          category: categorize(subject, body),
          is_warmup: 0,
        });
        stored++;
      }
    } finally {
      lock.release();
    }
    await client.logout();
    const msg = `${stored} new replies, ${warmupSkipped} warmup filtered`;
    db.prepare("INSERT INTO sync_log (kind, ok, detail, finished_at) VALUES ('inbox', 1, ?, datetime('now'))").run(msg);
    return msg;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await client.logout();
    } catch {}
    db.prepare("INSERT INTO sync_log (kind, ok, detail, finished_at) VALUES ('inbox', 0, ?, datetime('now'))").run(msg);
    return `Inbox sync failed: ${msg}`;
  }
}

// The `new Date()` calls above only feed message timestamps that already exist
// or fall back to "now" for undated mail — acceptable and not resume-sensitive.
