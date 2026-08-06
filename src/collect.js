import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SOURCE_URL = "https://geota.co.kr/gersang/satongpaldal?serverId=2";
const MAX_ITEMS = 300;
const KEEP_HOURS = 24;
const OUT_DIR = path.resolve("docs");
const DATA_FILE = path.join(OUT_DIR, "data.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function idFor(nickname, content) {
  return crypto.createHash("sha256").update(`${nickname}\n${content}`).digest("hex").slice(0, 24);
}

async function readOldData() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  } catch {
    return { items: [] };
  }
}

async function autoScroll(page) {
  let previousHeight = 0;
  let stableRounds = 0;

  for (let i = 0; i < 80; i += 1) {
    const state = await page.evaluate(() => {
      const body = document.scrollingElement || document.documentElement;
      window.scrollTo(0, body.scrollHeight);
      return {
        height: body.scrollHeight,
        textLength: document.body?.innerText?.length ?? 0
      };
    });

    await sleep(450);

    if (state.height === previousHeight) stableRounds += 1;
    else stableRounds = 0;

    previousHeight = state.height;
    if (stableRounds >= 5) break;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
}

async function extractRows(page) {
  return await page.evaluate((maxItems) => {
    const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    const timePattern = /^(방금\s*전|\d+\s*(초|분|시간|일)\s*전|\d{4}[./-]\d{1,2}[./-]\d{1,2}.*)$/;

    function fromTable() {
      const rows = [];
      for (const tr of document.querySelectorAll("table tbody tr")) {
        const cells = [...tr.querySelectorAll("td")].map((td) => clean(td.innerText));
        if (cells.length >= 3) {
          const timeIndex = cells.findIndex((v) => timePattern.test(v));
          if (timeIndex >= 2) {
            rows.push({
              nickname: cells[timeIndex - 2],
              content: cells[timeIndex - 1],
              displayTime: cells[timeIndex]
            });
          }
        }
      }
      return rows;
    }

    function fromRepeatedBlocks() {
      const candidates = [];
      const selectors = [
        "li", "article", "[role='listitem']",
        "div[class*='item']", "div[class*='row']",
        "div[class*='list'] > div"
      ];

      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const lines = clean(el.innerText).split(/\n+/).map(clean).filter(Boolean);
          if (lines.length < 3 || lines.length > 12) continue;

          const timeIndex = lines.findIndex((line) => timePattern.test(line));
          if (timeIndex >= 2) {
            candidates.push({
              nickname: lines[timeIndex - 2],
              content: lines[timeIndex - 1],
              displayTime: lines[timeIndex]
            });
          }
        }
      }
      return candidates;
    }

    function fromBodyLines() {
      const lines = String(document.body?.innerText ?? "")
        .split(/\n+/)
        .map(clean)
        .filter(Boolean);

      const rows = [];
      for (let i = 2; i < lines.length; i += 1) {
        if (!timePattern.test(lines[i])) continue;

        const nickname = lines[i - 2];
        const content = lines[i - 1];

        if (!nickname || !content) continue;
        if (/^(닉네임|내용|시간|서버|검색)$/.test(nickname)) continue;

        rows.push({
          nickname,
          content,
          displayTime: lines[i]
        });
      }
      return rows;
    }

    const combined = [...fromTable(), ...fromRepeatedBlocks(), ...fromBodyLines()];
    const unique = [];
    const seen = new Set();

    for (const row of combined) {
      const key = `${row.nickname}\n${row.content}\n${row.displayTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(row);
      if (unique.length >= maxItems) break;
    }

    return unique;
  }, MAX_ITEMS);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"]
  });

  const context = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/126.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();
  const collectedAt = new Date();

  try {
    await page.goto(SOURCE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);
    await autoScroll(page);

    const currentRows = await extractRows(page);

    if (currentRows.length === 0) {
      throw new Error(
        "게시글 행을 찾지 못했습니다. 사이트 구조 변경 또는 접근 차단 가능성이 있습니다."
      );
    }

    const oldData = await readOldData();
    const oldItems = Array.isArray(oldData.items) ? oldData.items : [];
    const cutoff = collectedAt.getTime() - KEEP_HOURS * 60 * 60 * 1000;

    const merged = new Map();

    for (const item of oldItems) {
      const lastSeenMs = Date.parse(item.lastSeenAt);
      if (Number.isFinite(lastSeenMs) && lastSeenMs >= cutoff) {
        merged.set(item.id, item);
      }
    }

    currentRows.forEach((row, index) => {
      const nickname = clean(row.nickname);
      const content = clean(row.content);
      const displayTime = clean(row.displayTime);

      if (!nickname || !content) return;

      const id = idFor(nickname, content);
      const existing = merged.get(id);

      merged.set(id, {
        id,
        nickname,
        content,
        displayTime,
        sourceRank: index + 1,
        firstSeenAt: existing?.firstSeenAt ?? collectedAt.toISOString(),
        lastSeenAt: collectedAt.toISOString()
      });
    });

    const items = [...merged.values()]
      .filter((item) => Date.parse(item.lastSeenAt) >= cutoff)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));

    const result = {
      ok: true,
      sourceUrl: SOURCE_URL,
      collectedAt: collectedAt.toISOString(),
      collectedCount: currentRows.length,
      storedCount: items.length,
      maxItemsPerRun: MAX_ITEMS,
      keepHours: KEEP_HOURS,
      items
    };

    await fs.writeFile(DATA_FILE, JSON.stringify(result, null, 2), "utf8");
    console.log(`수집 성공: 현재 ${currentRows.length}개, 24시간 보관 ${items.length}개`);
  } catch (error) {
    const oldData = await readOldData();
    const failure = {
      ...oldData,
      ok: false,
      sourceUrl: SOURCE_URL,
      lastAttemptAt: collectedAt.toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };

    await fs.writeFile(DATA_FILE, JSON.stringify(failure, null, 2), "utf8");
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
