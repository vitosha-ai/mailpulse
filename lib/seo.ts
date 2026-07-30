import { JWT } from "google-auth-library";
import { getDb, getSetting, setSetting } from "./db";

// SEO watchdog for the company website (not the cold-email fleet).
// Three independent checks, each a safe no-op until configured:
//  - rankings:   where seo_site_url + each competitor ranks on Google for
//                seo_keywords, via the Serper.dev API (weekly — free-tier credits)
//  - competitor pages: new URLs appearing in competitors' sitemaps (daily)
//  - search console:   clicks/impressions for our site via the same Google
//                service account used for the inbox reader (daily)
// Config lives in settings: serper_api_key, seo_site_url, seo_keywords
// (one per line), seo_competitors (one domain per line), seo_gsc_site.

const RANK_EVERY_DAYS = 6; // weekly-ish; a manual "run now" can force it

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDomain(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function lines(v: string | null): string[] {
  return (v ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getSeoConfig() {
  const site = normalizeDomain(getSetting("seo_site_url") ?? "");
  return {
    site,
    keywords: lines(getSetting("seo_keywords")),
    competitors: lines(getSetting("seo_competitors")).map(normalizeDomain),
    serperKey: getSetting("serper_api_key"),
    gscSite: getSetting("seo_gsc_site") ?? (site ? `sc-domain:${site}` : ""),
  };
}

// ---------------------------------------------------------------- rankings

type SerperOrganic = { position: number; link: string; title?: string };

function findDomain(organic: SerperOrganic[], domain: string): { position: number; url: string } | null {
  for (const r of organic) {
    try {
      const host = new URL(r.link).hostname.toLowerCase().replace(/^www\./, "");
      if (host === domain || host.endsWith("." + domain)) return { position: r.position, url: r.link };
    } catch {
      // unparseable link — skip
    }
  }
  return null;
}

export async function checkRankings(force = false): Promise<string> {
  const { site, keywords, competitors, serperKey } = getSeoConfig();
  if (!serperKey) return "Serper not configured";
  if (!site || keywords.length === 0) return "SEO site/keywords not configured";

  const db = getDb();
  const last = (db.prepare("SELECT MAX(date) AS d FROM seo_rank_history").get() as { d: string | null }).d;
  if (!force && last) {
    const age = (Date.now() - new Date(`${last}T00:00:00Z`).getTime()) / 86_400_000;
    if (age < RANK_EVERY_DAYS) return `rankings checked ${last}, next in ${Math.ceil(RANK_EVERY_DAYS - age)}d`;
  }

  const date = today();
  const upsert = db.prepare(
    `INSERT INTO seo_rank_history (keyword, domain, date, position, url)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(keyword, domain, date) DO UPDATE SET position = excluded.position, url = excluded.url`,
  );

  let searches = 0;
  for (const keyword of keywords) {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: keyword, num: 100, gl: "us", hl: "en" }),
    });
    if (!res.ok) return `Serper error ${res.status} on "${keyword}" (${searches} searches done)`;
    const data = (await res.json()) as { organic?: SerperOrganic[] };
    const organic = data.organic ?? [];
    searches += 1;

    // One search answers for our site AND every competitor at once.
    for (const domain of [site, ...competitors]) {
      const hit = findDomain(organic, domain);
      upsert.run(keyword, domain, date, hit?.position ?? null, hit?.url ?? null);
    }
  }
  return `rankings: ${keywords.length} keyword(s), ${searches} Serper searches`;
}

// -------------------------------------------------------- competitor pages

async function fetchSitemapUrls(domain: string): Promise<string[]> {
  const locs = async (url: string): Promise<string[]> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return [];
      const xml = await res.text();
      return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    } catch {
      return [];
    }
  };

  const first = await locs(`https://${domain}/sitemap.xml`);
  // A sitemap index lists child sitemaps rather than pages — follow a few.
  const children = first.filter((u) => /sitemap[^/]*\.xml/i.test(u)).slice(0, 5);
  if (children.length === 0) return first.slice(0, 500);
  const pages: string[] = first.filter((u) => !/sitemap[^/]*\.xml/i.test(u));
  for (const child of children) pages.push(...(await locs(child)));
  return pages.slice(0, 500);
}

export async function checkCompetitorPages(): Promise<string> {
  const { competitors } = getSeoConfig();
  if (competitors.length === 0) return "no competitors configured";

  const db = getDb();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO seo_competitor_pages (url, domain, first_seen) VALUES (?, ?, datetime('now'))",
  );
  // First crawl of a domain seeds the baseline silently (everything is "new"
  // on day one); the widget only surfaces pages first seen after the baseline.
  const known = db.prepare("SELECT COUNT(*) AS n FROM seo_competitor_pages WHERE domain = ?");

  let added = 0;
  for (const domain of competitors) {
    const urls = await fetchSitemapUrls(domain);
    if (urls.length === 0) continue;
    const isBaseline = (known.get(domain) as { n: number }).n === 0;
    const write = db.transaction((list: string[]) => {
      for (const u of list) {
        const r = insert.run(u, domain);
        if (!isBaseline && r.changes > 0) added += 1;
      }
    });
    write(urls);
  }
  setSetting("seo_pages_checked", today());
  return `competitor pages: ${added} new`;
}

// --------------------------------------------------------- search console

export async function syncSearchConsole(): Promise<string> {
  const { gscSite } = getSeoConfig();
  const saRaw = getSetting("google_sa_json");
  if (!saRaw || !gscSite) return "Search Console not configured";

  let sa: { client_email: string; private_key: string };
  try {
    sa = JSON.parse(saRaw);
  } catch {
    return "Google service-account JSON is invalid";
  }

  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) return "Search Console auth failed";

  const end = today();
  const startD = new Date();
  startD.setUTCDate(startD.getUTCDate() - 28);
  const start = startD.toISOString().slice(0, 10);

  const query = async (body: object) => {
    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(gscSite)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`GSC ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as { rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] };
  };

  try {
    const daily = await query({ startDate: start, endDate: end, dimensions: ["date"], rowLimit: 40 });
    const topQueries = await query({ startDate: start, endDate: end, dimensions: ["query"], rowLimit: 15 });

    const db = getDb();
    const upsert = db.prepare(
      `INSERT INTO seo_gsc_daily (date, clicks, impressions, ctr, position, top_queries)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(date) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions,
         ctr = excluded.ctr, position = excluded.position`,
    );
    const write = db.transaction(() => {
      for (const r of daily.rows ?? []) upsert.run(r.keys[0], r.clicks, r.impressions, r.ctr, r.position);
    });
    write();
    // Top queries for the window live on the newest row so the widget has one place to read.
    const newest = (daily.rows ?? []).at(-1)?.keys[0];
    if (newest) {
      db.prepare("UPDATE seo_gsc_daily SET top_queries = ? WHERE date = ?").run(
        JSON.stringify(
          (topQueries.rows ?? []).map((r) => ({
            query: r.keys[0],
            clicks: r.clicks,
            impressions: r.impressions,
            position: Math.round(r.position * 10) / 10,
          })),
        ),
        newest,
      );
    }
    setSetting("seo_gsc_checked", today());
    return `search console: ${daily.rows?.length ?? 0} day(s) synced`;
  } catch (e) {
    return `Search Console error: ${e instanceof Error ? e.message : e}`;
  }
}

// ---------------------------------------------------------------- orchestrator

export async function runSeo(force = false): Promise<{ rankings: string; pages: string; gsc: string }> {
  const db = getDb();
  const logId = db
    .prepare("INSERT INTO sync_log (kind) VALUES ('seo')")
    .run().lastInsertRowid;

  const report = {
    rankings: await checkRankings(force).catch((e) => `error: ${e instanceof Error ? e.message : e}`),
    pages:
      force || getSetting("seo_pages_checked") !== today()
        ? await checkCompetitorPages().catch((e) => `error: ${e instanceof Error ? e.message : e}`)
        : "competitor pages already checked today",
    gsc:
      force || getSetting("seo_gsc_checked") !== today()
        ? await syncSearchConsole().catch((e) => `error: ${e instanceof Error ? e.message : e}`)
        : "search console already synced today",
  };

  db.prepare("UPDATE sync_log SET finished_at = datetime('now'), ok = 1, detail = ? WHERE id = ?").run(
    JSON.stringify(report),
    logId,
  );
  return report;
}
