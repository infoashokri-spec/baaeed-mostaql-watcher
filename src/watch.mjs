import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = path.join(ROOT, "data", "state.json");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36";
const MAX_URLS_PER_SOURCE = 20_000;

export const SOURCES = [
  {
    key: "mostaql-projects",
    name: "مستقل - المشاريع الجديدة",
    pageUrl: "https://mostaql.com/projects",
    fallbackPageUrl:
      "https://mostaql-com.translate.goog/projects?_x_tr_sl=ar&_x_tr_tl=en&_x_tr_hl=en",
    canonicalHost: "mostaql.com",
    accepts: (url) => /^https:\/\/mostaql\.com\/project\/\d+-[^/?#]+\/?$/i.test(url),
  },
  {
    key: "baaeed-jobs",
    name: "بعيد - الوظائف الجديدة",
    pageUrl: "https://baaeed.com/remote-jobs",
    fallbackPageUrl:
      "https://baaeed-com.translate.goog/remote-jobs?_x_tr_sl=ar&_x_tr_tl=en&_x_tr_hl=en",
    canonicalHost: "baaeed.com",
    accepts: (url) => /^https:\/\/baaeed\.com\/remote-jobs\/[^/?#]+\/?$/i.test(url),
  },
];

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, number) =>
      String.fromCodePoint(Number.parseInt(number, 16)),
    )
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ");
}

function stripHtml(value) {
  return decodeEntities(
    String(value ?? "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(decodeEntities(href), baseUrl).href;
  } catch {
    return "";
  }
}

function titleFromUrl(url) {
  try {
    let slug = new URL(url).pathname.replace(/\/$/, "").split("/").pop() || url;
    slug = decodeURIComponent(slug).replace(/^\d+-/, "").replace(/[-_]+/g, " ");
    return slug.slice(0, 160);
  } catch {
    return String(url).slice(0, 160);
  }
}

export function canonicalizeTranslatedUrl(value, canonicalHost) {
  if (!value || !canonicalHost) return value;
  try {
    const url = new URL(value);
    const translatedHost = `${canonicalHost.replaceAll(".", "-")}.translate.goog`;
    if (url.hostname !== translatedHost) return value;
    url.hostname = canonicalHost;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

export function parseHtmlEntries(html, baseUrl, accepts, canonicalHost = "") {
  const entries = [];
  const seen = new Set();
  const pattern = /<a\b([^>]*)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const rawUrl = absoluteUrl(match[3], baseUrl);
    const url = canonicalizeTranslatedUrl(rawUrl, canonicalHost);
    if (!url || seen.has(url) || !accepts(url)) continue;
    seen.add(url);
    entries.push({ url, title: (stripHtml(match[5]) || titleFromUrl(url)).slice(0, 160) });
  }
  return entries;
}

export function parseSitemap(xml, accepts) {
  const entries = [];
  const seen = new Set();
  const pattern = /<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/gi;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const location = match[1].match(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/i)?.[1];
    if (!location) continue;
    const url = decodeEntities(location.trim());
    if (seen.has(url) || !accepts(url)) continue;
    seen.add(url);
    entries.push({ url, title: titleFromUrl(url) });
  }
  return entries;
}

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.text();
      lastError = new Error(`${new URL(url).hostname} returned HTTP ${response.status}.`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 750));
  }
  throw lastError || new Error(`${new URL(url).hostname} could not be reached.`);
}

async function loadSource(source) {
  if (source.type === "sitemap") {
    return parseSitemap(await fetchText(source.sourceUrl), source.accepts);
  }

  let pageUrl = source.pageUrl;
  let html;
  try {
    html = await fetchText(pageUrl, source.fallbackPageUrl ? 1 : 3);
  } catch (primaryError) {
    if (!source.fallbackPageUrl) throw primaryError;
    pageUrl = source.fallbackPageUrl;
    html = await fetchText(pageUrl);
  }
  return parseHtmlEntries(html, pageUrl, source.accepts, source.canonicalHost);
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram repository secrets are missing.");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}.`);
}

async function verifyTelegramConfiguration() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram repository secrets are missing.");

  const botResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!botResponse.ok) {
    throw new Error(`Telegram bot verification returned HTTP ${botResponse.status}.`);
  }

  const chatResponse = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!chatResponse.ok) {
    throw new Error(`Telegram chat verification returned HTTP ${chatResponse.status}.`);
  }

  console.log("Telegram bot and chat verified.");
}

async function sendNewLinks(source, entries) {
  for (let index = 0; index < entries.length; index += 6) {
    const batch = entries.slice(index, index + 6);
    const lines = [
      `📡 <b>${escapeHtml(source.name)}</b>`,
      `🆕 تم العثور على <b>${entries.length}</b> رابط جديد`,
      "",
      ...batch.map(
        (entry) =>
          `• <a href="${escapeHtml(entry.url)}">${escapeHtml(entry.title || titleFromUrl(entry.url))}</a>`,
      ),
    ];
    await sendTelegram(lines.join("\n"));
  }
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  } catch {
    return { version: 1, sources: {} };
  }
}

async function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

export async function run() {
  if (process.env.VERIFY_TELEGRAM === "true") {
    await verifyTelegramConfiguration();
  }

  const state = await loadState();
  state.version = 1;
  state.sources ||= {};
  let changed = false;
  let totalNewLinks = 0;
  const report = [];

  for (const source of SOURCES) {
    const previous = state.sources[source.key] || null;
    try {
      const entries = await loadSource(source);
      if (!entries.length) throw new Error("No matching public links were found.");

      if (!previous?.urls?.length) {
        state.sources[source.key] = {
          name: source.name,
          urls: entries.map((entry) => entry.url).slice(-MAX_URLS_PER_SOURCE),
          consecutiveErrors: 0,
          lastError: null,
        };
        changed = true;
        report.push({ source: source.name, status: "initialized", count: entries.length });
        continue;
      }

      const known = new Set(previous.urls);
      const newEntries = entries.filter((entry) => !known.has(entry.url));
      if (newEntries.length) await sendNewLinks(source, newEntries);
      for (const entry of entries) known.add(entry.url);

      const nextUrls = [...known].slice(-MAX_URLS_PER_SOURCE);
      if (
        newEntries.length ||
        previous.consecutiveErrors !== 0 ||
        previous.lastError !== null ||
        nextUrls.length !== previous.urls.length
      ) {
        state.sources[source.key] = {
          name: source.name,
          urls: nextUrls,
          consecutiveErrors: 0,
          lastError: null,
        };
        changed = true;
      }
      totalNewLinks += newEntries.length;
      report.push({ source: source.name, status: "ok", newLinks: newEntries.length });
    } catch (error) {
      const message = String(error?.message || error);
      const failures = Math.min((previous?.consecutiveErrors || 0) + 1, 3);
      state.sources[source.key] = {
        name: source.name,
        urls: previous?.urls || [],
        consecutiveErrors: failures,
        lastError: message,
      };
      changed ||= failures !== previous?.consecutiveErrors || message !== previous?.lastError;
      if (failures === 3 && previous?.consecutiveErrors !== 3) {
        await sendTelegram(
          `⚠️ <b>تعذرت المراقبة ثلاث مرات</b>\n📡 <b>${escapeHtml(source.name)}</b>\n${escapeHtml(message)}`,
        );
      }
      report.push({ source: source.name, status: "error", failures, error: message });
    }
  }

  if (changed) {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
  await writeOutput("state_changed", changed ? "true" : "false");
  await writeOutput("new_links", String(totalNewLinks));
  console.log(JSON.stringify({ changed, totalNewLinks, report }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
