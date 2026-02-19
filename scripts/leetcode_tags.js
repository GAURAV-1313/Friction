#!/usr/bin/env node
/**
 * Fetch LeetCode topic tags (name, slug, count) via GraphQL.
 *
 * Usage:
 *   LEETCODE_COOKIE="LEETCODE_SESSION=...; csrftoken=..." node scripts/leetcode_tags.js
 *
 * Output:
 *   data/leetcode_tags.json
 */

const fs = require("fs");
const path = require("path");

const COOKIE = process.env.LEETCODE_COOKIE || "";
if (!COOKIE) {
  console.error(
    "Missing LEETCODE_COOKIE. Set it like:\n" +
      'LEETCODE_COOKIE="LEETCODE_SESSION=...; csrftoken=..."'
  );
  process.exit(1);
}

const CSRF = (() => {
  const match = COOKIE.match(/csrftoken=([^;]+)/);
  return match ? match[1] : "";
})();

const ENDPOINT = "https://leetcode.com/graphql";
const LIMIT = 100;

const query = `
query problemsetQuestionListV2($categorySlug: String, $limit: Int, $skip: Int) {
  problemsetQuestionListV2(categorySlug: $categorySlug, limit: $limit, skip: $skip) {
    totalLength
    questions {
      topicTags {
        name
        slug
      }
    }
  }
}
`.trim();

async function fetchPage(skip) {
  const body = JSON.stringify({
    query,
    variables: {
      categorySlug: "",
      skip,
      limit: LIMIT
    }
  });

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "friction-tag-fetcher",
      Cookie: COOKIE,
      "x-csrftoken": CSRF,
      Referer: "https://leetcode.com/problemset/all/"
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  const list = json?.data?.problemsetQuestionListV2;
  if (!list) {
    throw new Error("Unexpected response shape. Check cookies or query.");
  }
  return list;
}

async function main() {
  console.log("Fetching total count...");
  const first = await fetchPage(0);
  const total = first.totalLength || 0;
  console.log(`Total problems: ${total}`);

  const counts = new Map();

  const addTags = (questions = []) => {
    for (const q of questions) {
      const tags = q.topicTags || [];
      for (const tag of tags) {
        if (!tag?.slug) continue;
        const key = tag.slug;
        const prev = counts.get(key) || { name: tag.name, slug: tag.slug, count: 0 };
        prev.count += 1;
        counts.set(key, prev);
      }
    }
  };

  addTags(first.questions || []);

  for (let skip = LIMIT; skip < total; skip += LIMIT) {
    console.log(`Fetching ${skip}–${Math.min(skip + LIMIT, total)}...`);
    const page = await fetchPage(skip);
    addTags(page.questions || []);
  }

  const output = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  const outDir = path.join(process.cwd(), "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "leetcode_tags.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Done. Wrote ${output.length} tags to ${outPath}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
