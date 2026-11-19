import Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createHash } from "node:crypto";
import { getDb, getSetting, setSetting } from "./db";

// US State & Local (SLED) RFP agent. Vitosha's BidPrime account (all US state
// and local bids) emails its saved-search alerts 3x a day. Those emails are
// forwarded to a dedicated mailbox; this agent reads that mailbox, has Claude
// Haiku pull every bid out of each email and judge it against Vitosha's seven
// service lines, drops junk with plain rules, de-duplicates, and fills the
// SLED board. The team gets ONE digest email per working day.
//
// BidPrime has no export/API on Vitosha's plan, so the alert email is the feed.
// The email layout is read by the model (not a hand-written parser), so a
// BidPrime template change doesn't break the feed.

const MODEL = "claude-haiku-5-5";
// $ per million tokens (Claude Haiku 5.5, prompts under 100K tokens).
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
const MIN_DAYS_TO_DUE = 3;
const CHUNK_CHARS = 30_000;

export const SLED_STATUSES = ["New", "Reviewing", "Go", "No Bid", "Submitted"] as const;
export const SERVICE_LINES = [
  "Data & AI",
  "ERP & Enterprise Systems",
  "App Dev & Modernization",
  "Custom Software & Support",
  "IT Managed Services",
  "IT Staffing",
  "None",
] as const;
const ENTITY_TYPES = ["State", "City/County", "K-12", "Higher Ed", "Transit/Port/Airport", "Utility", "Health", "Other"] as const;
const FITS = ["Strong", "Maybe", "Drop"] as const;

export type SledOpp = {
  id: string;
  title: string;
  agency: string;
  state: string;
  entity_type: string;
  refnum: string;
  posted_date: string;
  due_date: string;
  url: string;
  alert_name: string;
  service_line: string;
  tier: "Strong" | "Maybe" | "Drop";
  reason: string;
  status: string;
  notes: string;
  first_seen: string;
  last_seen: string;
  sent_at: string | null;
};

function ensureTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS sled_opps (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      agency TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      refnum TEXT NOT NULL DEFAULT '',
      posted_date TEXT NOT NULL DEFAULT '',
      due_date TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      alert_name TEXT NOT NULL DEFAULT '',
      service_line TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL DEFAULT 'Maybe',
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'New',
      notes TEXT NOT NULL DEFAULT '',
      title_key TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT (date('now')),
      last_seen TEXT NOT NULL DEFAULT (date('now')),
      sent_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sled_due ON sled_opps(due_date);
    CREATE INDEX IF NOT EXISTS idx_sled_titlekey ON sled_opps(title_key, state);
    CREATE TABLE IF NOT EXISTS sled_emails (
      msg_key TEXT PRIMARY KEY,
      received_at TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '[]',
      bids_found INTEGER NOT NULL DEFAULT 0,
      processed_at TEXT,
      error TEXT NOT NULL DEFAULT ''
    );
  `);
}

// ---------------------------------------------------------------------------
// Email -> plain text with numbered links ([L1], [L2]...). The model returns a
// link number, never a URL, so long tracking links are never mistyped.

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–",
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
};
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
    if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });

export function emailToText(html: string | null, text: string | null): { body: string; links: string[] } {
  const links: string[] = [];
  if (html) {
    let s = html.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ");
    s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = decode(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (!label || /^(mailto:|tel:|#)/i.test(href)) return ` ${label} `;
      links.push(decode(href));
      return ` ${label} [L${links.length}] `;
    });
    s = s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d|table|section)>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(/<[^>]+>/g, " ");
    return { body: tidy(decode(s)), links };
  }
  const t = (text || "").replace(/https?:\/\/[^\s<>)\]]+/g, (u) => {
    links.push(u);
    return `[L${links.length}]`;
  });
  return { body: tidy(t), links };
}

const tidy = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/[ \t |]+$/g, "").replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l && l !== "|")
    .join("\n");

function chunks(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of body.split("\n")) {
    if (cur.length + line.length > CHUNK_CHARS && cur) {
      out.push(cur);
      cur = "";
    }
    cur += line + "\n";
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Claude Haiku: extract every bid + judge fit, in one call per email chunk.

const SYSTEM = `You read BidPrime bid-alert emails for Vitosha, an IT services company, and turn them into structured rows.

Vitosha's service lines:
- Data & AI: analytics, BI, dashboards, data warehouse/lake, data integration/migration/governance, AI/ML, generative AI, chatbots, RPA and intelligent automation, AI strategy or roadmaps.
- ERP & Enterprise Systems: ERP, financial/accounting/budget/payroll/HR (HRIS/HCM) systems, utility billing, asset/work-order management (CMMS/EAM), student information systems, and their selection, implementation, migration or support (Oracle, Workday, SAP, Tyler, Infor, Dynamics, etc.).
- App Dev & Modernization: custom applications, web/mobile apps, portals, websites, CRM (Salesforce, Dynamics), ServiceNow, case management, permitting/licensing, records/document management, low-code/Power Platform, legacy or mainframe modernization, systems/API integration of software.
- Custom Software & Support: software development, maintenance and support of applications, internal tools.
- IT Managed Services: managed IT, help desk/service desk, IT support services, cloud/infrastructure managed services, IT outsourcing.
- IT Staffing: IT staff augmentation, technology staffing, IT temporary/contract staff, IT professional services on a time-and-materials basis.

For EVERY bid listed in the email (skip nothing; ignore headers, footers, unsubscribe and account links), return one row:
- title: the bid title exactly as shown.
- agency: the issuing agency/entity name, without the state prefix.
- state: two-letter US state code, or "" if unknown.
- entity_type: the kind of agency, inferred from its name.
- refnum: the bid/solicitation reference number if shown, else "".
- posted_date / due_date: YYYY-MM-DD, or "" if not shown. Due = closing/response date.
- link_id: the [L#] marker attached to the bid's title (e.g. "L12"), or "" if none.
- alert_name: the saved-search / keyword group the bid is listed under, if the email groups bids, else "".
- service_line: the best-fitting Vitosha service line, or "None".
- fit:
  - Strong: the work itself is clearly one of the service lines above (Vitosha would deliver it).
  - Maybe: IT work that could fit but is unclear, mostly product/licence with some services, or a small adjacent piece.
  - Drop: not IT services work - construction, building systems, engineering, audio-visual, physical security, hardware or software licence purchases/renewals only, equipment, supplies, facilities, medical/clinical, training courses, grants to individuals, or anything federal or outside the US.
- reason: one short sentence explaining the fit, in plain English.

Judge from the title and agency only. When unsure between Strong and Maybe, choose Maybe. When unsure between Maybe and Drop for clearly non-IT work, choose Drop.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bids"],
  properties: {
    bids: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "agency", "state", "entity_type", "refnum", "posted_date", "due_date", "link_id", "alert_name", "service_line", "fit", "reason"],
        properties: {
          title: { type: "string" },
          agency: { type: "string" },
          state: { type: "string" },
          entity_type: { type: "string", enum: [...ENTITY_TYPES] },
          refnum: { type: "string" },
          posted_date: { type: "string" },
          due_date: { type: "string" },
          link_id: { type: "string" },
          alert_name: { type: "string" },
          service_line: { type: "string", enum: [...SERVICE_LINES] },
          fit: { type: "string", enum: [...FITS] },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

type ExtractedBid = {
  title: string; agency: string; state: string; entity_type: string; refnum: string;
  posted_date: string; due_date: string; link_id: string; alert_name: string;
  service_line: string; fit: (typeof FITS)[number]; reason: string;
};

export function anthropicKey() {
  return process.env.ANTHROPIC_API_KEY || getSetting("anthropic_api_key") || "";
}

let client: Anthropic | null = null;
function ai() {
  if (!client) client = new Anthropic({ apiKey: anthropicKey() });
  return client;
}

function trackUsage(input: number, output: number) {
  const prev = JSON.parse(getSetting("sled_ai_usage") || "{}") as { calls?: number; input?: number; output?: number; usd?: number };
  const usd = (input * PRICE_IN + output * PRICE_OUT) / 1_000_000;
  setSetting(
    "sled_ai_usage",
    JSON.stringify({
      calls: (prev.calls || 0) + 1,
      input: (prev.input || 0) + input,
      output: (prev.output || 0) + output,
      usd: Number(((prev.usd || 0) + usd).toFixed(4)),
    }),
  );
}

async function extractBids(subject: string, chunk: string): Promise<ExtractedBid[]> {
  const stream = ai().messages.stream({
    model: MODEL,
    max_tokens: 32000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: `Alert email subject: ${subject}\n\n${chunk}` }],
  });
  const msg = await stream.finalMessage();
  trackUsage(msg.usage.input_tokens, msg.usage.output_tokens);
  if (msg.stop_reason === "refusal") throw new Error("model declined this email");
  if (msg.stop_reason === "max_tokens") throw new Error("email too long for one pass");
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const parsed = JSON.parse(text) as { bids: ExtractedBid[] };
  return parsed.bids || [];
}

// ---------------------------------------------------------------------------
// Plain rules on top of the model: no junk reaches the team.

const FEDERAL_OR_FOREIGN =
  /\bU\.?\s?S\.? (department|national|army|navy|air force)|department of (war|defense|the interior|veterans)|national (institutes of health|aeronautics|science foundation)|grants\.gov|\bSBIR\b|united nations|\bUNDP\b|world bank|\bNASA\b/i;
const JUNK_TITLE =
  /elevator|escalator|roofing|\broof\b|hvac|paving|asphalt|janitor|custodial|landscap|mowing|construction|renovat|design[- ]build|demolition|audio ?visual|nurse call|scada|plumbing|flooring|carpet|fencing|uniforms?\b|food service|vehicles?\b|trucks?\b|ferr(y|ies)|trolley/i;
const IT_WORD =
  /software|system|\bdata\b|digital|technology|\bIT\b|application|portal|\bERP\b|cloud|\bAI\b|artificial intelligence|analytics|website|platform|network|cyber/i;

function applyRules(b: ExtractedBid, cutoff: string): { fit: ExtractedBid["fit"]; reason: string } | null {
  if (b.due_date && b.due_date < cutoff) return null; // closes too soon to bid
  if (FEDERAL_OR_FOREIGN.test(b.agency) || FEDERAL_OR_FOREIGN.test(b.title)) {
    return { fit: "Drop", reason: "Federal or international notice, not state/local (federal bids are on the Federal board)." };
  }
  if (JUNK_TITLE.test(b.title) && !IT_WORD.test(b.title)) {
    return { fit: "Drop", reason: "Construction, building or equipment work, not IT services." };
  }
  return { fit: b.fit, reason: b.reason };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function dayPlus(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export type SledProcessReport = { bids: number; inserted: number; updated: number; dropped: number; tooLate: number; newIds: string[] };

// Turn one stored alert email into board rows. Safe to re-run: rows are keyed
// by bid, so a bid listed under several alerts (or in several emails) folds
// into one row and keeps the team's status and notes.
export async function processEmail(msgKey: string): Promise<SledProcessReport> {
  ensureTables();
  const db = getDb();
  const em = db.prepare("SELECT * FROM sled_emails WHERE msg_key = ?").get(msgKey) as
    | { subject: string; body: string; links: string }
    | undefined;
  if (!em) throw new Error("email not found");
  const links = JSON.parse(em.links) as string[];
  const report: SledProcessReport = { bids: 0, inserted: 0, updated: 0, dropped: 0, tooLate: 0, newIds: [] };

  const bids: ExtractedBid[] = [];
  for (const c of chunks(em.body)) bids.push(...(await extractBids(em.subject, c)));
  report.bids = bids.length;

  const cutoff = dayPlus(MIN_DAYS_TO_DUE);
  const byId = db.prepare("SELECT id FROM sled_opps WHERE id = ?");
  // The same bid is often posted by two names for one agency (e.g. a state's
  // procurement office and the department). Same title + state = same bid.
  const byTitle = db.prepare("SELECT id FROM sled_opps WHERE title_key = ? AND state = ? AND title_key <> '' LIMIT 1");
  const insert = db.prepare(`
    INSERT INTO sled_opps (id, title, agency, state, entity_type, refnum, posted_date, due_date, url,
      alert_name, service_line, tier, reason, title_key)
    VALUES (@id, @title, @agency, @state, @entity_type, @refnum, @posted_date, @due_date, @url,
      @alert_name, @service_line, @tier, @reason, @title_key)`);
  const touch = db.prepare(`
    UPDATE sled_opps SET last_seen = date('now'), updated_at = datetime('now'),
      due_date = CASE WHEN @due_date <> '' THEN @due_date ELSE due_date END,
      url = CASE WHEN url = '' THEN @url ELSE url END,
      refnum = CASE WHEN refnum = '' THEN @refnum ELSE refnum END,
      alert_name = CASE WHEN alert_name = '' THEN @alert_name
                        WHEN @alert_name = '' OR instr(alert_name, @alert_name) > 0 THEN alert_name
                        ELSE alert_name || ', ' || @alert_name END
    WHERE id = @id`);

  db.transaction(() => {
    for (const b of bids) {
      if (!b.title.trim()) continue;
      const ruled = applyRules(b, cutoff);
      if (!ruled) { report.tooLate++; continue; }
      if (ruled.fit === "Drop") report.dropped++;
      const state = (b.state || "").toUpperCase().slice(0, 2);
      const titleKey = norm(b.title);
      const m = /^L(\d+)$/.exec(b.link_id.trim());
      const url = m ? links[Number(m[1]) - 1] || "" : "";
      // BidPrime links carry the bid's own id (…/bid/link/source/<uuid>): the
      // most reliable key. Otherwise fall back to ref # + agency, or title + agency.
      const bidUuid = /\/bid\/link\/source\/([0-9a-f-]{36})/i.exec(url)?.[1]?.toLowerCase();
      const keyBase = b.refnum ? `${norm(b.refnum)}|${norm(b.agency)}` : `${titleKey}|${norm(b.agency)}`;
      const newId = bidUuid ? `bp-${bidUuid}` : hash(keyBase);
      const existing =
        (byId.get(newId) as { id: string } | undefined) ??
        (byId.get(hash(keyBase)) as { id: string } | undefined) ??
        (byTitle.get(titleKey, state) as { id: string } | undefined);
      const row = {
        id: existing?.id ?? newId,
        title: b.title.trim(),
        agency: b.agency.trim(),
        state,
        entity_type: b.entity_type,
        refnum: b.refnum.trim(),
        posted_date: /^\d{4}-\d{2}-\d{2}$/.test(b.posted_date) ? b.posted_date : "",
        due_date: /^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : "",
        url,
        alert_name: b.alert_name.trim(),
        service_line: ruled.fit === "Drop" ? "None" : b.service_line,
        tier: ruled.fit,
        reason: ruled.reason,
        title_key: titleKey,
      };
      if (existing) {
        touch.run(row);
        report.updated++;
      } else {
        insert.run(row);
        report.inserted++;
        if (row.tier !== "Drop") report.newIds.push(row.id);
      }
    }
    db.prepare("UPDATE sled_emails SET bids_found = ?, processed_at = datetime('now'), error = '' WHERE msg_key = ?").run(bids.length, msgKey);
  })();
  return report;
}

export function storeEmail(msgKey: string, receivedAt: string, subject: string, html: string | null, text: string | null) {
  ensureTables();
  const { body, links } = emailToText(html, text);
  getDb()
    .prepare(
      `INSERT INTO sled_emails (msg_key, received_at, subject, body, links) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(msg_key) DO NOTHING`,
    )
    .run(msgKey, receivedAt, subject, body, JSON.stringify(links));
}

// ---------------------------------------------------------------------------
// Mailbox reader. BidPrime alerts land in proposals@vitoshainc.com. Preferred
// path: Gmail API with the gmail.readonly scope through the Workspace service
// account (domain-wide delegation) - Google itself guarantees it can only
// read. Fallback: IMAP with an app password (reads with PEEK, so nothing is
// marked read). Either way only BidPrime messages are downloaded.

const DEFAULT_MAILBOX = "proposals@vitoshainc.com";

function gmailConfig() {
  const raw = process.env.GOOGLE_SA_JSON || getSetting("google_sa_json") || "";
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw) as { client_email?: string; private_key?: string };
    if (!sa.client_email || !sa.private_key) return null;
    const mailbox = process.env.SLED_MAILBOX || getSetting("sled_mailbox") || DEFAULT_MAILBOX;
    return { sa: { client_email: sa.client_email, private_key: sa.private_key }, mailbox };
  } catch {
    return null;
  }
}

type Collected = { stored: string[]; skipped: number };

async function collectViaGmailApi(cfg: NonNullable<ReturnType<typeof gmailConfig>>): Promise<Collected> {
  const { JWT } = await import("google-auth-library");
  const jwt = new JWT({
    email: cfg.sa.client_email,
    key: cfg.sa.private_key,
    subject: cfg.mailbox,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  });
  const { access_token } = await jwt.authorize();
  const auth = { Authorization: `Bearer ${access_token}` };
  const base = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(cfg.mailbox)}`;
  const seen = getDb().prepare("SELECT 1 FROM sled_emails WHERE msg_key = ?");
  const out: Collected = { stored: [], skipped: 0 };

  // Only BidPrime mail, last 7 days (overlap is harmless: already-stored ids are skipped).
  let pageToken = "";
  do {
    const q = encodeURIComponent("from:bidprime.com newer_than:7d");
    const r = await fetch(`${base}/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`, { headers: auth });
    if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const list = (await r.json()) as { messages?: { id: string }[]; nextPageToken?: string };
    for (const { id } of list.messages ?? []) {
      const key = `gmail-${id}`;
      if (seen.get(key)) continue;
      const m = await fetch(`${base}/messages/${id}?format=raw`, { headers: auth });
      if (!m.ok) continue;
      const { raw } = (await m.json()) as { raw?: string };
      if (!raw) continue;
      const p = await simpleParser(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
      const html = typeof p.html === "string" ? p.html : "";
      if (!isBidPrime(p.from?.text || "", p.subject || "", html)) { out.skipped++; continue; }
      storeEmail(key, (p.date ?? new Date()).toISOString(), p.subject || "", html || null, p.text || null);
      out.stored.push(key);
    }
    pageToken = list.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function collectViaImap(cfg: NonNullable<ReturnType<typeof imapConfig>>): Promise<Collected> {
  const out: Collected = { stored: [], skipped: 0 };
  const lastUid = Number(getSetting("sled_imap_last_uid") || 0);
  const imap = new ImapFlow(cfg);
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      // Server-side filter: only messages from BidPrime. First run looks back 7 days.
      const uids = lastUid
        ? ((await imap.search({ from: "bidprime", uid: `${lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > lastUid)
        : (await imap.search({ from: "bidprime", since: new Date(Date.now() - 7 * 86_400_000) }, { uid: true })) || [];
      let maxUid = lastUid;
      for (const uid of uids) {
        // `source` is fetched with BODY.PEEK, so the message stays unread.
        const msg = await imap.fetchOne(String(uid), { source: true }, { uid: true });
        maxUid = Math.max(maxUid, uid);
        if (!msg || !msg.source) continue;
        const p = await simpleParser(msg.source as Buffer);
        const html = typeof p.html === "string" ? p.html : "";
        if (!isBidPrime(p.from?.text || "", p.subject || "", html)) { out.skipped++; continue; }
        const key = p.messageId || `uid-${uid}`;
        storeEmail(key, (p.date ?? new Date()).toISOString(), p.subject || "", html || null, p.text || null);
        out.stored.push(key);
      }
      setSetting("sled_imap_last_uid", String(maxUid));
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
  return out;
}

function imapConfig() {
  const user = process.env.SLED_IMAP_USER || getSetting("sled_imap_user") || "";
  const pass = process.env.SLED_IMAP_PASS || getSetting("sled_imap_pass") || "";
  if (!user || !pass) return null;
  return {
    host: process.env.SLED_IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.SLED_IMAP_PORT || 993),
    secure: true,
    auth: { user, pass },
    logger: false as const,
  };
}

const isBidPrime = (from: string, subject: string, html: string) =>
  /bidprime/i.test(from) || /bidprime/i.test(subject) || /bidprime\.com/i.test(html.slice(0, 200_000));

export type SledRunReport = { emails: number; skipped: number; failed: number; bids: number; inserted: number; updated: number; dropped: number; tooLate: number; newIds: string[]; note?: string };

export async function runSled(): Promise<SledRunReport> {
  ensureTables();
  const db = getDb();
  const report: SledRunReport = { emails: 0, skipped: 0, failed: 0, bids: 0, inserted: 0, updated: 0, dropped: 0, tooLate: 0, newIds: [] };
  const gmail = gmailConfig();
  const imap = gmail ? null : imapConfig();
  if (!gmail && !imap) return { ...report, note: "Mailbox access not set up (read-only Gmail access to proposals@, or SLED_IMAP_USER / SLED_IMAP_PASS)" };
  if (!anthropicKey()) return { ...report, note: "ANTHROPIC_API_KEY not configured" };

  const got = gmail ? await collectViaGmailApi(gmail) : await collectViaImap(imap!);
  report.skipped = got.skipped;

  // Also retry any email a previous run stored but couldn't process.
  const pending = db.prepare("SELECT msg_key FROM sled_emails WHERE processed_at IS NULL").all() as { msg_key: string }[];
  for (const { msg_key } of pending) {
    try {
      const r = await processEmail(msg_key);
      report.emails++;
      report.bids += r.bids;
      report.inserted += r.inserted;
      report.updated += r.updated;
      report.dropped += r.dropped;
      report.tooLate += r.tooLate;
      report.newIds.push(...r.newIds);
    } catch (e) {
      report.failed++;
      db.prepare("UPDATE sled_emails SET error = ? WHERE msg_key = ?").run(e instanceof Error ? e.message : String(e), msg_key);
    }
  }
  setSetting("sled_last_run", new Date().toISOString());
  setSetting("sled_last_report", JSON.stringify({ ...report, newIds: report.newIds.length }));
  return report;
}

// ---------------------------------------------------------------------------
// Working days: Mon-Fri except US federal holidays (owner's team calendar).

function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday as string };
}

function nthWeekday(year: number, month: number, weekday: number, n: number) {
  // n = 1..4, or -1 for the last one. month is 0-based.
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return new Date(Date.UTC(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7));
  }
  const last = new Date(Date.UTC(year, month + 1, 0));
  return new Date(Date.UTC(year, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7)));
}

function observed(d: Date) {
  const day = d.getUTCDay();
  if (day === 6) return new Date(d.getTime() - 86_400_000);
  if (day === 0) return new Date(d.getTime() + 86_400_000);
  return d;
}

export function federalHolidays(year: number): Set<string> {
  const fixed = (m: number, d: number) => observed(new Date(Date.UTC(year, m, d)));
  return new Set(
    [
      fixed(0, 1), nthWeekday(year, 0, 1, 3), nthWeekday(year, 1, 1, 3), nthWeekday(year, 4, 1, -1),
      fixed(5, 19), fixed(6, 4), nthWeekday(year, 8, 1, 1), nthWeekday(year, 9, 1, 2),
      fixed(10, 11), nthWeekday(year, 10, 4, 4), fixed(11, 25),
    ].map((d) => d.toISOString().slice(0, 10)),
  );
}

export function isWorkingDayET(d = new Date()) {
  const { ymd, weekday } = etParts(d);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return !federalHolidays(Number(ymd.slice(0, 4))).has(ymd);
}
export const etNow = etParts;

// ---------------------------------------------------------------------------
// Read, Excel, the one daily digest.

export function listOpen(opts: { includeDrops?: boolean; includeClosed?: boolean } = {}): SledOpp[] {
  ensureTables();
  const today = new Date().toISOString().slice(0, 10);
  return getDb()
    .prepare(
      `SELECT * FROM sled_opps
        WHERE (? OR tier <> 'Drop') AND (? OR due_date = '' OR due_date >= ?)
        ORDER BY CASE tier WHEN 'Strong' THEN 0 WHEN 'Maybe' THEN 1 ELSE 2 END,
                 CASE WHEN due_date = '' THEN '9999' ELSE due_date END ASC`,
    )
    .all(opts.includeDrops ? 1 : 0, opts.includeClosed ? 1 : 0, today) as SledOpp[];
}

export function updateOpp(id: string, patch: { status?: string; notes?: string }) {
  ensureTables();
  if (patch.status && !(SLED_STATUSES as readonly string[]).includes(patch.status)) throw new Error("bad status");
  const db = getDb();
  if (patch.status !== undefined) db.prepare("UPDATE sled_opps SET status = ?, updated_at = datetime('now') WHERE id = ?").run(patch.status, id);
  if (patch.notes !== undefined) db.prepare("UPDATE sled_opps SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(patch.notes, id);
}

export async function buildWorkbook(rows: SledOpp[], newIds: Set<string>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("SLED opportunities", { views: [{ state: "frozen", xSplit: 3, ySplit: 1 }] });
  const cols: [string, number][] = [
    ["Fit", 9], ["Service line", 24], ["Title", 60], ["New", 6], ["Agency", 36], ["State", 7], ["Agency type", 18],
    ["Due", 11], ["Posted", 11], ["Ref #", 18], ["Why", 60], ["Status", 11], ["BidPrime alert", 26], ["Link", 10],
  ];
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
  const fills: Record<string, string> = { Strong: "FFC6EFCE", Maybe: "FFFFEB9C", Drop: "FFF2F2F2" };
  rows.forEach((r) => {
    const row = ws.addRow([
      r.tier, r.service_line, r.title, newIds.has(r.id) ? "NEW" : "", r.agency, r.state, r.entity_type,
      r.due_date, r.posted_date, r.refnum, r.reason, r.status, r.alert_name,
      r.url ? { text: "Open", hyperlink: r.url } : "",
    ]);
    row.alignment = { vertical: "top" };
    row.getCell(3).alignment = { vertical: "top", wrapText: true };
    row.getCell(11).alignment = { vertical: "top", wrapText: true };
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fills[r.tier] } };
    row.getCell(14).font = { color: { argb: "FF0563C1" }, underline: true };
    if (newIds.has(r.id)) row.getCell(4).font = { bold: true, color: { argb: "FF0B40B0" } };
  });
  ws.autoFilter = { from: "A1", to: { row: rows.length + 1, column: cols.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// daily = true: only Strong/Maybe bids never emailed before, then mark them sent.
// daily = false: manual test send of everything open (marks nothing).
export async function emailDigest(daily: boolean, toOverride?: string): Promise<string> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return "RESEND_API_KEY not configured";
  const to = (toOverride || emailRecipients()).split(/[,;\s]+/).filter(Boolean);
  if (to.length === 0) return "No recipient set (sled_email_to)";

  const open = listOpen();
  const rows = daily ? open.filter((r) => !r.sent_at) : open;
  const date = etParts().ymd;
  const strong = rows.filter((r) => r.tier === "Strong").length;
  const quiet = daily && rows.length === 0;
  const subject = quiet
    ? `State & Local RFPs ${date}: no new opportunities today`
    : `State & Local RFPs ${date}: ${rows.length} ${daily ? "new" : "open"} (${strong} strong fit)${daily ? "" : " - test"}`;

  const groups: { line: string; items: SledOpp[] }[] = SERVICE_LINES.filter((s) => s !== "None")
    .map((line) => ({ line: line as string, items: rows.filter((r) => r.service_line === line) }))
    .filter((g) => g.items.length);
  const other = rows.filter((r) => !SERVICE_LINES.slice(0, 6).includes(r.service_line as (typeof SERVICE_LINES)[number]));
  if (other.length) groups.push({ line: "None", items: other });

  const item = (r: SledOpp) =>
    `<tr><td style="padding:3px 8px;vertical-align:top"><b style="color:${r.tier === "Strong" ? "#047857" : "#b45309"}">${r.tier}</b></td>` +
    `<td style="padding:3px 8px">${r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title)}<br>` +
    `<span style="color:#64748b;font-size:12px">${esc(r.agency)}${r.state ? ", " + r.state : ""} · due ${r.due_date || "n/a"} · ${esc(r.reason)}</span></td></tr>`;
  const sections = groups
    .map((g) => `<p style="margin:16px 0 4px"><b>${g.line === "None" ? "Other IT" : esc(g.line)}</b> (${g.items.length})</p><table style="border-collapse:collapse">${g.items.slice(0, 15).map(item).join("")}</table>` +
      (g.items.length > 15 ? `<p style="color:#64748b;font-size:12px">+${g.items.length - 15} more in the attached Excel</p>` : ""))
    .join("");
  const footer = `<p style="color:#64748b;font-size:12px">Source: BidPrime saved searches (all US state &amp; local). Construction, equipment, licence-only, federal and anything closing within 3 days are left out. Full list on the State &amp; Local RFPs board in MailPulse.</p><p style="color:#64748b;font-size:12px">— MailPulse · State &amp; Local agent</p>`;
  const html = quiet
    ? `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a"><p>No new state &amp; local opportunities matched Vitosha's services since the last email.</p><p>${open.length} are still open on the board.</p>${footer}</div>`
    : `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a"><p>${rows.length} ${daily ? "new" : "open"} state &amp; local opportunities matching Vitosha's services (${strong} strong fit), grouped by service line. The full list is attached.</p>${sections}${footer}</div>`;

  const xlsx = quiet ? null : await buildWorkbook(rows, new Set(daily ? rows.map((r) => r.id) : []));
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.SLED_EMAIL_FROM || process.env.FEDERAL_EMAIL_FROM || "MailPulse State & Local RFPs <no-reply@vitosha-inc.com>",
      to,
      subject,
      html,
      ...(xlsx ? { attachments: [{ filename: `State_Local_RFPs_${date}.xlsx`, content: xlsx.toString("base64") }] } : {}),
    }),
  });
  if (!r.ok) return `Resend ${r.status}: ${(await r.text()).slice(0, 200)}`;
  if (daily && rows.length) {
    const mark = getDb().prepare("UPDATE sled_opps SET sent_at = datetime('now') WHERE id = ?");
    getDb().transaction(() => rows.forEach((x) => mark.run(x.id)))();
  }
  setSetting("sled_last_email", new Date().toISOString());
  return `sent to ${to.join(", ")}`;
}

const DEFAULT_RECIPIENTS = "proposals@vitoshainc.com, ajay@vitoshainc.com";
function emailRecipients() {
  return getSetting("sled_email_to") || DEFAULT_RECIPIENTS;
}

export function sledConfig() {
  ensureTables();
  const gmail = gmailConfig();
  const cfg = imapConfig();
  const failed = getDb().prepare("SELECT COUNT(*) n FROM sled_emails WHERE processed_at IS NULL AND error <> ''").get() as { n: number };
  return {
    mailbox: gmail ? `${gmail.mailbox} (read-only)` : cfg ? cfg.auth.user : null,
    ai: Boolean(anthropicKey()),
    resend: Boolean(process.env.RESEND_API_KEY),
    emailTo: emailRecipients(),
    lastRun: getSetting("sled_last_run"),
    lastReport: getSetting("sled_last_report"),
    lastEmail: getSetting("sled_last_email"),
    aiUsage: getSetting("sled_ai_usage"),
    failedEmails: failed.n,
  };
}

export function sledStats() {
  ensureTables();
  const rows = listOpen();
  const today = new Date().toISOString().slice(0, 10);
  const live = rows.filter((r) => r.status !== "No Bid");
  return {
    open: live.length,
    strong: live.filter((r) => r.tier === "Strong").length,
    fresh: rows.filter((r) => r.first_seen === today).length,
  };
}
