import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeTranslatedUrl,
  parseHtmlEntries,
  parseSitemap,
} from "../src/watch.mjs";

test("extracts and deduplicates matching HTML links", () => {
  const html = `
    <a href="/project/123-first">المشروع الأول</a>
    <a href="/project/123-first">مكرر</a>
    <a href="/users/1">مستخدم</a>
  `;
  const entries = parseHtmlEntries(
    html,
    "https://mostaql.com/projects",
    (url) => /^https:\/\/mostaql\.com\/project\/\d+-/.test(url),
  );
  assert.deepEqual(entries, [
    { url: "https://mostaql.com/project/123-first", title: "المشروع الأول" },
  ]);
});

test("canonicalizes Google Translate fallback links", () => {
  assert.equal(
    canonicalizeTranslatedUrl(
      "https://baaeed-com.translate.goog/remote-jobs/test?_x_tr_sl=ar",
      "baaeed.com",
    ),
    "https://baaeed.com/remote-jobs/test",
  );
});

test("parses matching sitemap entries", () => {
  const xml = `
    <urlset>
      <url><loc>https://careers.accor.com/job/riyadh-test-saudi-arabia-jid-1</loc></url>
      <url><loc>https://careers.accor.com/job/paris-test-france-jid-2</loc></url>
    </urlset>
  `;
  const entries = parseSitemap(xml, (url) => /-saudi-arabia-jid-/.test(url));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, "https://careers.accor.com/job/riyadh-test-saudi-arabia-jid-1");
});
