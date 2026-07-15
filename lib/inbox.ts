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
  // The warmup fingerprint: a mixed letter+digit code token like "DAVM9XE",
  // "H6791SG", "TQNZ5F8". Real words ("UPDATE") lack digits; years ("2026")
  // lack letters — so neither trips this.
  const tokens = tail.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => t.length >= 5 && /^[A-Z0-9]+$/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t)))
    return true;
  // token joiners: underscore or double-hyphen (blow_coat_avoid, blind--hundred)
  if (/_|--/.test(tail)) return true;
  // a long lowercase gibberish word (saidspentplanextra)
  if (/^[a-z]{10,}$/.test(compact)) return true;
  // lowercase gibberish blob followed by an uppercase code (…extra H6791SG)
  if (/^[a-z]{6,}[A-Z0-9]{2,}$/.test(compact)) return true;
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

export function getFleetDomains(): Set<string> {
  const db = getDb();
  return new Set(
    (db.prepare("SELECT DISTINCT domain FROM senders WHERE domain != ''").all() as { domain: string }[]).map(
      (r) => r.domain.toLowerCase(),
    ),
  );
}

const SOURCE_OFFSET: Record<string, number> = { google: 2_000_000_000_000, microsoft: 3_000_000_000_000 };

// Shared insert used by every mail source (IMAP, Gmail, Graph). Applies the
// warmup filter, categorizes real replies, and dedupes by (source, ext_id).
// Returns what happened so callers can count.
export function storeMessage(opts: {
  source: "maildoso" | "google" | "microsoft";
  extId: string;
  uid?: number; // provided for maildoso (the IMAP uid); computed otherwise
  messageId: string | null;
  fromEmail: string;
  fromName: string;
  toEmail: string;
  subject: string;
  body: string;
  headers: string;
  date: string;
  fleetDomains: Set<string>;
}): "stored" | "warmup" | "skip" {
  const db = getDb();
  const warmup = isWarmupMessage({
    subject: opts.subject,
    body: opts.body,
    headers: opts.headers,
    fromEmail: opts.fromEmail,
    toEmail: opts.toEmail,
    fleetDomains: opts.fleetDomains,
  });

  let uid = opts.uid;
  if (uid == null) {
    const offset = SOURCE_OFFSET[opts.source] ?? 1;
    const row = db
      .prepare("SELECT COALESCE(MAX(uid), ?) AS m FROM inbox_messages WHERE source = ?")
      .get(offset, opts.source) as { m: number };
    uid = Number(row.m) + 1;
  }

  const info = db
    .prepare(
      `INSERT INTO inbox_messages
        (uid, source, ext_id, message_id, from_email, from_name, to_email, subject, preview, body, received_at, category, is_warmup, seen)
       VALUES (@uid, @source, @ext_id, @message_id, @from_email, @from_name, @to_email, @subject, @preview, @body, @received_at, @category, @is_warmup, 0)
       ON CONFLICT(source, ext_id) DO NOTHING`,
    )
    .run({
      uid,
      source: opts.source,
      ext_id: opts.extId,
      message_id: opts.messageId,
      from_email: opts.fromEmail,
      from_name: opts.fromName,
      to_email: opts.toEmail,
      subject: warmup ? opts.subject.slice(0, 200) : opts.subject,
      preview: warmup ? null : opts.body.slice(0, 300),
      body: warmup ? null : opts.body,
      received_at: opts.date,
      category: warmup ? null : categorize(opts.subject, opts.body, opts.headers, opts.fromEmail),
      is_warmup: warmup ? 1 : 0,
    });
  if (info.changes === 0) return "skip"; // already had it
  return warmup ? "warmup" : "stored";
}

// Was this message written in response to something we sent? Real prospect
// replies carry an In-Reply-To/References header or a Re:/Fwd: subject.
function isReply(subject: string, headers: string): boolean {
  if (/^\s*(re|fwd?|aw|sv|antw)\s*:/i.test(subject)) return true;
  return /(^|\n)\s*(in-reply-to|references)\s*:/i.test(headers);
}

// Unsolicited mail sent TO our sender addresses: cold pitches from vendors,
// newsletters, product notifications. Our sender domains are publicly visible,
// so they get harvested and spammed — none of that is a prospect reply.
// Principle: a fresh thread (not a reply) carrying broadcast-mail fingerprints.
export function isJunk(subject: string, body: string, headers: string, fromEmail: string): boolean {
  if (isReply(subject, headers)) return false;

  const local = (fromEmail.split("@")[0] ?? "").toLowerCase();
  // Sender local-parts that are never a human prospect.
  if (/^(no-?reply|do-?not-?reply|notifications?|newsletters?|news|marketing|updates?|billing|invoices?|receipts?|alerts?|digest|hello|team|community|onboarding|success|careers|jobs)([._+-].*)?$/.test(local))
    return true;

  const h = headers.toLowerCase();
  // Broadcast/campaign fingerprints on a fresh (non-reply) thread.
  if (h.includes("list-unsubscribe")) return true;
  if (/precedence\s*:\s*(bulk|list|junk)/.test(h)) return true;
  if (/x-(campaign|mailchimp|sendgrid|mailgun|ses-outgoing|postmark|hubspot|marketo|klaviyo|brevo|sendinblue|constantcontact|mandrill|sparkpost)/.test(h))
    return true;

  // Unsubscribe/preferences footer in a fresh thread = broadcast mail.
  if (/unsubscribe|manage (your )?(email )?preferences|update (your )?preferences|why (did i|am i) (get|receiv)/i.test(body))
    return true;

  return false;
}

// Lightweight intent classifier for stored mail. Order matters: bounces and
// human intents are recognized first; junk (unsolicited broadcast) is checked
// before "interested" so a newsletter saying "pricing" can't masquerade as a
// hot reply; anything left is "other".
export function categorize(subject: string, body: string, headers = "", fromEmail = ""): string {
  const t = `${subject} ${body}`.toLowerCase();
  if (/mailer-daemon|delivery (status|has failed)|undeliverable|failure notice|postmaster/.test(t))
    return "auto-reply";
  if (/\bout of (the )?office\b|\bon (leave|vacation|holiday|pto)\b|automatic reply|auto[- ]?reply|away from my (desk|email)/.test(t))
    return "out-of-office";
  if (/\bunsubscrib|\bremove me\b|\bopt[- ]?out\b|\bstop emailing\b|\btake me off\b|\bdo not (contact|email)\b/.test(t))
    return isReply(subject, headers) || !isJunk(subject, body, headers, fromEmail) ? "unsubscribe" : "junk";
  if (isJunk(subject, body, headers, fromEmail)) return "junk";
  if (/\b(interested|sounds good|let'?s (talk|chat|connect)|book a (call|time|meeting)|schedule|tell me more|how much|pricing|send (me )?(more|info|details)|happy to|keen|yes[.,! ])/.test(t))
    return "interested";
  return "other";
}

// Retro-classify already-stored messages as junk. Headers weren't stored, so
// this uses conservative signals only: a fresh thread (subject lacks Re:/Fwd:)
// from a no-reply-style sender, or carrying an unsubscribe/preferences footer.
export function reclassifyJunk(): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT uid, from_email, subject, COALESCE(body,'') AS body FROM inbox_messages
       WHERE is_warmup = 0 AND COALESCE(category,'') NOT IN ('junk','unsubscribe','out-of-office','auto-reply')`,
    )
    .all() as { uid: number; from_email: string; subject: string; body: string }[];
  const flag = db.prepare("UPDATE inbox_messages SET category = 'junk' WHERE uid = ?");
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (isJunk(r.subject || "", r.body, "", r.from_email || "")) {
        flag.run(r.uid);
        n++;
      }
    }
  });
  tx();
  return n;
}

export async function syncInbox(): Promise<string> {
  const db = getDb();
  const cfg = await imapConfig();
  if (!cfg) return "Master inbox not configured — add a Maildoso API key or IMAP details in Settings";

  const fleetDomains = getFleetDomains();

  const client = new ImapFlow(cfg);
  let stored = 0;
  let warmupSkipped = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Highest maildoso UID we already have — only fetch newer messages.
      const maxRow = db
        .prepare("SELECT MAX(uid) AS m FROM inbox_messages WHERE source = 'maildoso'")
        .get() as { m: number | null };
      const since = (maxRow.m ?? 0) + 1;

      // Fetch source for new UIDs. The 3rd arg { uid: true } makes the range
      // UID-based, so "since:*" (since = max UID + 1) means "everything with a
      // higher UID" — not a sequence number (which would overflow and fail).
      for await (const msg of client.fetch(`${since}:*`, { uid: true, source: true }, { uid: true })) {
        const parsed = await simpleParser(msg.source as Buffer);
        const r = storeMessage({
          source: "maildoso",
          uid: Number(msg.uid),
          extId: String(msg.uid),
          messageId: parsed.messageId ?? null,
          fromEmail: parsed.from?.value?.[0]?.address?.toLowerCase() ?? "",
          fromName: parsed.from?.value?.[0]?.name ?? "",
          toEmail:
            (Array.isArray(parsed.to) ? parsed.to[0] : parsed.to)?.value?.[0]?.address?.toLowerCase() ?? "",
          subject: parsed.subject ?? "",
          body: (parsed.text ?? "").trim(),
          headers: [...(parsed.headerLines ?? [])].map((h) => h.line).join("\n"),
          date: (parsed.date ?? new Date()).toISOString(),
          fleetDomains,
        });
        if (r === "warmup") warmupSkipped++;
        else if (r === "stored") stored++;
      }
    } finally {
      lock.release();
    }
    await client.logout();
    // Belt-and-braces: re-scan for warmup and junk that slipped past earlier filters.
    const recl = reclassifyWarmup();
    const junked = reclassifyJunk();
    const msg = `${stored} new replies, ${warmupSkipped + recl} warmup filtered, ${junked} junk reclassified`;
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
