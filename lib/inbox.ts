import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getDb, getSetting } from "./db";
import { discoverMasterInboxImap } from "./maildoso";

// Reads the Maildoso master inbox over IMAP, filters out warmup traffic, and
// stores real prospect replies. Credentials come either from the manual IMAP
// fields or are auto-discovered from a Maildoso API token.

async function imapConfig() {
  // With a Maildoso token, always refresh the master email + password from the
  // API (the password can rotate); the host comes from settings/default.
  if (getSetting("maildoso_api_key")) {
    const creds = await discoverMasterInboxImap();
    if (creds) {
      return {
        host: creds.host,
        port: creds.port,
        secure: creds.port === 993,
        auth: { user: creds.user, pass: creds.pass },
        logger: false as const,
        tls: { rejectUnauthorized: false },
      };
    }
  }
  // Manual IMAP fallback.
  const host = getSetting("imap_host");
  const user = getSetting("imap_user");
  const pass = getSetting("imap_pass");
  const port = Number(getSetting("imap_port") ?? "993");
  if (!host || !user || !pass) return null;
  return {
    host,
    port,
    secure: port === 993,
    auth: { user, pass },
    logger: false as const,
    tls: { rejectUnauthorized: false },
  };
}

// A message is warmup noise if it carries a known warmup marker or comes from
// a mailbox that belongs to our own fleet (warmup network chatter). Instantly
// stamps warmup mail with an identifier in the body/subject/headers.
// The decisive warmup signature (verified against the live master inbox):
// warmup tools append a hidden token block after a "|" in the subject —
// random words joined by _ / -- / . and/or a short uppercase alphanumeric
// code, e.g. "… | blind--hundred  H6791SG", "… |  DAVM9X", "… | mud__roof".
// Real prospect replies do not carry this. Exported so it can also reclassify
// already-stored messages.
export function hasWarmupTag(subject: string): boolean {
  const i = subject.lastIndexOf("|");
  if (i < 0) return false;
  const tail = subject.slice(i + 1).trim();
  if (!tail) return false;
  const compact = tail.replace(/\s+/g, "");
  // lone uppercase/alphanumeric code (DAVM9X, TQNZ5, H6791SG)
  if (/^[A-Z0-9]{4,12}$/.test(compact)) return true;
  // token joiners: underscore or double-hyphen
  if (/_|--/.test(tail)) return true;
  // a long lowercase gibberish word (saidspentplanextra)
  if (/^[a-z]{10,}$/.test(compact)) return true;
  // lowercase gibberish blob followed by a short uppercase code (…extra H67)
  if (/^[a-z]{6,}[A-Z0-9]{2,}$/.test(compact)) return true;
  // lowercase words ending in an uppercase code (half.love H6791SG)
  if (/^[a-z].*[A-Z0-9]{4,}$/.test(compact)) return true;
  // dotted lowercase tokens (community.customs, half.love)
  if (/^[a-z]+\.[a-z]/.test(compact)) return true;
  return false;
}

function isWarmupMessage(input: {
  subject: string;
  body: string;
  headers: string;
  fromEmail: string;
  toEmail: string;
  fleetDomains: Set<string>;
}): boolean {
  // 1) The subject warmup token — the strongest, most reliable signal.
  if (hasWarmupTag(input.subject)) return true;

  // 2) Warmup tools also stamp identifiable headers.
  const headersLc = input.headers.toLowerCase();
  const headerMarkers = [
    "x-instantly",
    "x-warmup",
    "x-tw-",
    "x-mailwarm",
    "x-emailwarmup",
    "list-id: warmup",
    "warmup-id",
    "x-warmupinbox",
    "x-wu-",
    "feedback-id: warmup",
  ];
  if (headerMarkers.some((m) => headersLc.includes(m))) return true;

  // 3) Mail FROM one of our own fleet domains is warmup-network chatter.
  const fromDomain = input.fromEmail.split("@")[1]?.toLowerCase() ?? "";
  if (fromDomain && input.fleetDomains.has(fromDomain)) return true;

  // 4) Literal "warmup" mention.
  if (/\bwarm[\s-]?up\b/.test(`${input.subject}\n${input.body}`.toLowerCase())) return true;

  return false;
}

// Re-scan already-stored messages and flag any that match the warmup signature
// (used after tightening the filter, so old imports get cleaned too).
export function reclassifyWarmup(): number {
  const db = getDb();
  const rows = db
    .prepare("SELECT uid, subject FROM inbox_messages WHERE is_warmup = 0")
    .all() as { uid: number; subject: string }[];
  const flag = db.prepare("UPDATE inbox_messages SET is_warmup = 1 WHERE uid = ?");
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (hasWarmupTag(r.subject || "")) {
        flag.run(r.uid);
        n++;
      }
    }
  });
  tx();
  return n;
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

        const warmup = isWarmupMessage({ subject, body, headers, fromEmail, toEmail, fleetDomains });
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
    // Belt-and-braces: re-scan for any warmup that slipped past the live filter.
    const recl = reclassifyWarmup();
    const msg = `${stored} new replies, ${warmupSkipped + recl} warmup filtered`;
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
