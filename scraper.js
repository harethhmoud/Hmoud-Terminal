const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "scraper-state.json");
const NEWS_FILE = path.join(__dirname, "scraped-news.json");
const MAX_VISITED_URLS = 500;
const MAX_ARTICLES = 100;
const SCRAPE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// ── Category mapping ────────────────────────────────────────────────────

const CATEGORY_RULES = [
  { keywords: ["earnings", "revenue", "profit", "quarter", "eps", "beat", "miss"], tag: "earnings", tagLabel: "EARNINGS" },
  { keywords: ["tech", "chip", "ai", "software", "cloud", "cyber"], tag: "tech", tagLabel: "TECH" },
  { keywords: ["crypto", "bitcoin", "ethereum", "btc", "eth", "blockchain"], tag: "crypto", tagLabel: "CRYPTO" },
  { keywords: ["fed", "rate", "treasury", "inflation", "cpi", "jobs", "employment"], tag: "fed", tagLabel: "FED" },
  { keywords: ["oil", "energy", "solar", "gas", "renewable", "opec"], tag: "energy", tagLabel: "ENERGY" },
];

function categorize(headline) {
  const lower = headline.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) {
        return { tag: rule.tag, tagLabel: rule.tagLabel };
      }
    }
  }
  return { tag: "market", tagLabel: "MARKET" };
}

// ── State persistence ───────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (_) {}
  return { visitedUrls: [] };
}

function saveState(state) {
  // Cap visited URLs to prevent unbounded growth
  if (state.visitedUrls.length > MAX_VISITED_URLS) {
    state.visitedUrls = state.visitedUrls.slice(-MAX_VISITED_URLS);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadNews() {
  try {
    if (fs.existsSync(NEWS_FILE)) {
      return JSON.parse(fs.readFileSync(NEWS_FILE, "utf8"));
    }
  } catch (_) {}
  return { articles: [], lastUpdated: null };
}

function saveNews(newsData) {
  // Keep only the most recent articles
  if (newsData.articles.length > MAX_ARTICLES) {
    newsData.articles = newsData.articles.slice(-MAX_ARTICLES);
  }
  newsData.lastUpdated = new Date().toISOString();
  fs.writeFileSync(NEWS_FILE, JSON.stringify(newsData, null, 2));
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return sleep(min + Math.random() * (max - min));
}

// ── Main scraper ────────────────────────────────────────────────────────

async function scrape(browser) {
  const state = loadState();
  const visitedSet = new Set(state.visitedUrls);

  const page = await browser.newPage();

  try {
    console.log("[scraper] Navigating to Yahoo Finance...");
    await page.goto("https://finance.yahoo.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(2000);

    // Handle cookie consent if it appears
    try {
      const consentBtn = page.locator('button:has-text("Accept All")');
      if (await consentBtn.isVisible({ timeout: 2000 })) {
        await consentBtn.click();
        await sleep(1000);
      }
    } catch (_) {}

    // Scroll down 3-4 times to trigger lazy-loaded content
    const scrollCount = 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < scrollCount; i++) {
      console.log(`[scraper] Scrolling (${i + 1}/${scrollCount})...`);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
      await randomDelay(1500, 3000);
    }

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1000);

    // Extract all article links from the homepage
    console.log("[scraper] Extracting article links...");
    const links = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const anchors = document.querySelectorAll('a[href*="/news/"], a[href*="/m/"]');

      for (const a of anchors) {
        const href = a.href;
        if (!href || seen.has(href)) continue;

        // Get the headline text from the anchor or its children
        const text =
          a.textContent.trim() ||
          (a.querySelector("h3") && a.querySelector("h3").textContent.trim()) ||
          "";

        if (text.length < 15) continue; // Skip non-headline links

        seen.add(href);
        results.push({ url: href, headline: text });
      }
      return results;
    });

    console.log(`[scraper] Found ${links.length} article links on homepage`);

    // Filter to only new URLs
    const newLinks = links.filter((l) => !visitedSet.has(l.url));
    console.log(`[scraper] ${newLinks.length} new articles to process`);

    if (newLinks.length === 0) {
      await page.close();
      return;
    }

    const newArticles = [];

    for (const link of newLinks) {
      try {
        console.log(`[scraper] Visiting: ${link.url.slice(0, 80)}...`);
        await page.goto(link.url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await sleep(1500);

        // Extract article details
        const details = await page.evaluate(() => {
          // Headline: look for the article h1
          const h1 = document.querySelector(
            'h1[data-test-locator="headline"], header h1, article h1, h1'
          );
          const headline = h1 ? h1.textContent.trim() : "";

          // Source/byline
          const sourceEl = document.querySelector(
            '[class*="byline"] a, [class*="provider"] a, [data-test-locator="byline"] a, [class*="author"] a'
          );
          const source = sourceEl ? sourceEl.textContent.trim() : "";

          return { headline, source };
        });

        const headline = details.headline || link.headline;
        const source = details.source || "Yahoo Finance";

        if (headline.length < 10) {
          visitedSet.add(link.url);
          continue;
        }

        const category = categorize(headline);
        newArticles.push({
          tag: category.tag,
          tagLabel: category.tagLabel,
          headline: headline,
          url: link.url,
          source: source,
        });

        visitedSet.add(link.url);
        await randomDelay(800, 1500);
      } catch (err) {
        console.log(`[scraper] Error on article, skipping: ${err.message}`);
        visitedSet.add(link.url);
        continue;
      }
    }

    console.log(`[scraper] Successfully scraped ${newArticles.length} new articles`);

    // Save results
    if (newArticles.length > 0) {
      const newsData = loadNews();
      newsData.articles = newsData.articles.concat(newArticles);
      saveNews(newsData);
      console.log(`[scraper] Total articles in file: ${newsData.articles.length}`);
    }

    // Update visited URLs
    state.visitedUrls = Array.from(visitedSet);
    saveState(state);
  } catch (err) {
    console.error("[scraper] Scrape cycle error:", err.message);
  } finally {
    await page.close();
  }
}

// ── Entry point ─────────────────────────────────────────────────────────

async function main() {
  console.log("[scraper] Starting Yahoo Finance scraper...");
  console.log("[scraper] Launching browser (visible window)...");

  const browser = await chromium.launch({
    headless: false,
  });

  console.log("[scraper] Browser launched. Starting scrape loop.");

  // Run immediately, then on interval
  while (true) {
    try {
      await scrape(browser);
    } catch (err) {
      console.error("[scraper] Fatal error in scrape cycle:", err.message);
    }

    console.log(
      `[scraper] Waiting ${SCRAPE_INTERVAL_MS / 1000}s until next scrape...`
    );
    await sleep(SCRAPE_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("[scraper] Fatal error:", err);
  process.exit(1);
});
