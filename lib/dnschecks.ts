import { Resolver } from "node:dns/promises";
import { getSetting } from "./db";

// Domain hygiene checks: MX, SPF, DKIM (common selectors), DMARC, blocklists.
// These are the "why is this sender failing" signals.

const resolver = new Resolver();
resolver.setServers(["8.8.8.8", "1.1.1.1"]); // for MX/TXT lookups (NOT blocklists)

// Blocklist queries must NOT go through public resolvers (Spamhaus blocks
// them), so those go through the system resolver or a Spamhaus DQS key.
const blResolver = new Resolver();

const DKIM_SELECTORS = [
  "google", // Google Workspace
  "selector1", // Microsoft 365
  "selector2",
  "default",
  "k1",
  "s1",
  "s2",
  "mail",
  "dkim",
  "smtp",
];

export type DomainCheck = {
  domain: string;
  mx_ok: boolean;
  mx_provider: string | null;
  spf_ok: boolean;
  spf_record: string | null;
  dkim_ok: boolean;
  dkim_selector: string | null;
  dmarc_ok: boolean;
  dmarc_record: string | null;
  blocklists: BlocklistResult[];
};

export type BlocklistResult = {
  list: string;
  listed: boolean;
  code: string | null;
  error: string | null;
};

async function txt(name: string): Promise<string[]> {
  try {
    const records = await resolver.resolveTxt(name);
    return records.map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

function classifyMx(hosts: string[]): string | null {
  const joined = hosts.join(" ").toLowerCase();
  if (joined.includes("google.com") || joined.includes("googlemail")) return "google";
  if (joined.includes("protection.outlook.com")) return "microsoft";
  // Maildoso-provisioned domains use per-domain MX hosts like
  // _dc-mx.<hash>.<domain> (observed on this fleet, July 2026).
  if (joined.includes("maildoso") || joined.includes("mxrouting") || joined.includes("_dc-mx."))
    return "maildoso";
  return hosts.length ? "other" : null;
}

export async function checkDomain(domain: string): Promise<DomainCheck> {
  const [mxHosts, rootTxt, dmarcTxt] = await Promise.all([
    resolver.resolveMx(domain).then(
      (mx) => mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange),
      () => [] as string[],
    ),
    txt(domain),
    txt(`_dmarc.${domain}`),
  ]);

  const spfRecord = rootTxt.find((r) => r.toLowerCase().startsWith("v=spf1")) ?? null;
  const dmarcRecord = dmarcTxt.find((r) => r.toLowerCase().startsWith("v=dmarc1")) ?? null;

  // DKIM: try common selectors until one resolves to a key.
  let dkimSelector: string | null = null;
  for (const sel of DKIM_SELECTORS) {
    const recs = await txt(`${sel}._domainkey.${domain}`);
    if (recs.some((r) => r.toLowerCase().includes("v=dkim1") || r.includes("p="))) {
      dkimSelector = sel;
      break;
    }
  }

  const blocklists = await checkBlocklists(domain);

  return {
    domain,
    mx_ok: mxHosts.length > 0,
    mx_provider: classifyMx(mxHosts),
    spf_ok: !!spfRecord,
    spf_record: spfRecord,
    dkim_ok: !!dkimSelector,
    dkim_selector: dkimSelector,
    dmarc_ok: !!dmarcRecord,
    dmarc_record: dmarcRecord,
    blocklists,
  };
}

// Spamhaus special return codes: 127.255.255.x means "your query was refused"
// (public resolver / over quota) — that is an ERROR, not a listing. Same idea
// for URIBL's 127.0.0.255. Misreading these as "listed" is the classic bug.
function interpret(list: string, addresses: string[]): BlocklistResult {
  const refused =
    addresses.some((a) => a.startsWith("127.255.255.")) ||
    (list.includes("uribl") && addresses.includes("127.0.0.255"));
  if (refused) {
    return { list, listed: false, code: addresses[0] ?? null, error: "query refused (resolver blocked or over quota)" };
  }
  return { list, listed: addresses.length > 0, code: addresses[0] ?? null, error: null };
}

async function queryBl(list: string, qname: string): Promise<BlocklistResult> {
  try {
    const addresses = await blResolver.resolve4(qname);
    return interpret(list, addresses);
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { list, listed: false, code: null, error: null }; // NXDOMAIN = not listed
    }
    return { list, listed: false, code: null, error: code ?? "lookup failed" };
  }
}

export async function checkBlocklists(domain: string): Promise<BlocklistResult[]> {
  const dqsKey = getSetting("spamhaus_dqs_key");
  const checks: Promise<BlocklistResult>[] = [];

  if (dqsKey) {
    checks.push(queryBl("spamhaus-dbl", `${domain}.${dqsKey}.dbl.dq.spamhaus.net`));
  } else {
    // Fallback via system resolver; will report "refused" if blocked.
    checks.push(queryBl("spamhaus-dbl", `${domain}.dbl.spamhaus.org`));
  }
  checks.push(queryBl("surbl", `${domain}.multi.surbl.org`));
  checks.push(queryBl("uribl", `${domain}.multi.uribl.com`));

  return Promise.all(checks);
}
