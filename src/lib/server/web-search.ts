import { z } from "zod";
import { JSDOM } from "jsdom";
import { readLimitedResponseText } from "@/lib/server/web-content";

const braveSearchBaseUrl = "https://api.search.brave.com/res/v1";
const webSearchMaxBytes = 1024 * 1024;
const duckDuckGoSearchUrl = "https://html.duckduckgo.com/html/";
const bingWebSearchUrl = "https://www.bing.com/search";
const googleNewsSearchUrl = "https://news.google.com/rss/search";

const freshnessValues = {
  any: null,
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
} as const;

export const webSearchSchema = z.object({
  query: z.string().trim().min(1).max(400).refine((query) => query.split(/\s+/).length <= 50, "搜索词最多 50 个单词"),
  type: z.enum(["web", "news"]).default("web"),
  freshness: z.enum(["any", "day", "week", "month", "year"]).default("any"),
  count: z.number().int().min(1).max(10).default(8),
  country: z.string().trim().regex(/^(?:[A-Za-z]{2}|ALL)$/).optional(),
  searchLanguage: z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,8})?$/).optional(),
});

export type WebSearchArgs = z.infer<typeof webSearchSchema>;

export type WebSearchResult = {
  title: string;
  url: string;
  description: string;
  source: string;
  publishedAt: string | null;
  age: string | null;
};

export type WebSearchResponse = {
  provider: "brave" | "duckduckgo_html" | "bing_rss" | "google_news_rss";
  query: string;
  alteredQuery: string | null;
  type: WebSearchArgs["type"];
  freshness: WebSearchArgs["freshness"];
  results: WebSearchResult[];
  moreResultsAvailable: boolean;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function htmlText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return text(JSDOM.fragment(value).textContent, maxLength);
}

function publicResultUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function resultSource(item: JsonRecord, url: string): string {
  const profile = record(item.profile);
  const metaUrl = record(item.meta_url);
  const source = record(item.source);
  return text(source?.name, 160)
    || text(item.source, 160)
    || text(profile?.long_name, 160)
    || text(metaUrl?.hostname, 160)
    || new URL(url).hostname;
}

function normalizeResult(value: unknown): WebSearchResult | null {
  const item = record(value);
  if (!item) return null;
  const url = publicResultUrl(item.url);
  const title = text(item.title, 300);
  if (!url || !title) return null;
  return {
    title,
    url,
    description: text(item.description ?? item.snippet, 1_000),
    source: resultSource(item, url),
    publishedAt: text(item.page_age ?? item.published_at, 100) || null,
    age: text(item.age, 100) || null,
  };
}

function alteredQuery(payload: JsonRecord): string | null {
  const query = record(payload.query);
  return text(query?.altered, 400) || null;
}

function errorMessage(payload: unknown): string {
  const root = record(payload);
  const error = record(root?.error);
  const detail = text(error?.detail ?? error?.message ?? root?.message, 500);
  return detail || "搜索服务未返回错误详情";
}

function defaultLocale(query: string): { country?: string; searchLanguage?: string } {
  return /[\u3400-\u9fff]/u.test(query) ? { country: "CN", searchLanguage: "zh-hans" } : {};
}

async function runBraveSearch(args: WebSearchArgs, signal: AbortSignal, apiKey: string): Promise<WebSearchResponse> {
  const locale = defaultLocale(args.query);
  const url = new URL(`${braveSearchBaseUrl}/${args.type}/search`);
  url.searchParams.set("q", args.query);
  url.searchParams.set("count", String(args.count));
  url.searchParams.set("safesearch", "strict");
  url.searchParams.set("spellcheck", "true");
  url.searchParams.set("operators", "true");
  const country = args.country?.toUpperCase() ?? locale.country;
  const searchLanguage = args.searchLanguage?.toLowerCase() ?? locale.searchLanguage;
  if (country) url.searchParams.set("country", country);
  if (searchLanguage) url.searchParams.set("search_lang", searchLanguage);
  const freshness = freshnessValues[args.freshness];
  if (freshness) url.searchParams.set("freshness", freshness);
  if (args.type === "web") url.searchParams.set("text_decorations", "false");

  const response = await fetch(url, {
    signal,
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
      "x-subscription-token": apiKey,
    },
  });
  const body = await readLimitedResponseText(response, webSearchMaxBytes);
  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    throw new Error(`web_search 请求失败（HTTP ${response.status}）：搜索服务返回了无效 JSON`);
  }
  if (!response.ok) throw new Error(`web_search 请求失败（HTTP ${response.status}）：${errorMessage(payload)}`);

  const root = record(payload) ?? {};
  const web = record(root.web);
  const rawResults = args.type === "news"
    ? root.results
    : web?.results;
  const results = (Array.isArray(rawResults) ? rawResults : [])
    .map(normalizeResult)
    .filter((item): item is WebSearchResult => Boolean(item))
    .slice(0, args.count);

  return {
    provider: "brave",
    query: args.query,
    alteredQuery: alteredQuery(root),
    type: args.type,
    freshness: args.freshness,
    results,
    moreResultsAvailable: Boolean(args.type === "web" ? web?.more_results_available : root.more_results_available),
  };
}

const bingFreshness = {
  any: null,
  day: 'ex1:"ez1"',
  week: 'ex1:"ez2"',
  month: 'ex1:"ez3"',
  year: 'ex1:"ez5"',
} as const;

const duckDuckGoFreshness = {
  any: null,
  day: "d",
  week: "w",
  month: "m",
  year: "y",
} as const;

const googleNewsFreshness = {
  any: null,
  day: "when:1d",
  week: "when:7d",
  month: "when:30d",
  year: "when:365d",
} as const;

function normalizedPublishedAt(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 100) : date.toISOString();
}

function rssResults(xml: string, feedUrl: string, count: number): { results: WebSearchResult[]; total: number } {
  const dom = new JSDOM(xml, { contentType: "text/xml", url: feedUrl });
  if (dom.window.document.querySelector("parsererror")) throw new Error("web_search 搜索源返回了无效 RSS");
  const items = Array.from(dom.window.document.querySelectorAll("item"));
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const item of items) {
    const url = publicResultUrl(item.querySelector("link")?.textContent?.trim());
    const title = text(item.querySelector("title")?.textContent, 300);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title,
      url,
      description: htmlText(item.querySelector("description")?.textContent, 1_000),
      source: text(item.querySelector("source")?.textContent, 160) || new URL(url).hostname,
      publishedAt: normalizedPublishedAt(text(item.querySelector("pubDate")?.textContent, 100)),
      age: null,
    });
    if (results.length >= count) break;
  }
  return { results, total: items.length };
}

function duckDuckGoResultUrl(value: string | null, pageUrl: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, pageUrl);
    const redirected = url.hostname.endsWith("duckduckgo.com") ? url.searchParams.get("uddg") : null;
    return publicResultUrl(redirected ?? url.href);
  } catch {
    return null;
  }
}

function duckDuckGoResults(html: string, pageUrl: string, count: number): {
  results: WebSearchResult[];
  total: number;
  challengeDetected: boolean;
  explicitNoResults: boolean;
} {
  const document = new JSDOM(html, { url: pageUrl }).window.document;
  const entries = Array.from(document.querySelectorAll(".result:not(.result--no-result)"));
  const challengeDetected = Boolean(document.querySelector("#challenge-form, form[action*='/anomaly.js']"));
  const explicitNoResults = Boolean(document.querySelector(".no-results, .result--no-result"));
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const entry of entries) {
    const link = entry.querySelector<HTMLAnchorElement>(".result__a");
    const url = duckDuckGoResultUrl(link?.getAttribute("href") ?? null, pageUrl);
    const title = text(link?.textContent, 300);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title,
      url,
      description: text(entry.querySelector(".result__snippet")?.textContent, 1_000),
      source: new URL(url).hostname,
      publishedAt: null,
      age: null,
    });
    if (results.length >= count) break;
  }
  return { results, total: entries.length, challengeDetected, explicitNoResults };
}

async function runDuckDuckGoSearch(args: WebSearchArgs, signal: AbortSignal): Promise<WebSearchResponse> {
  const url = new URL(duckDuckGoSearchUrl);
  url.searchParams.set("q", args.query);
  const freshness = duckDuckGoFreshness[args.freshness];
  if (freshness) url.searchParams.set("df", freshness);
  const response = await fetch(url, {
    signal,
    redirect: "follow",
    headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; OceanKing/1.0)" },
  });
  if (!response.ok) throw new Error(`DuckDuckGo 搜索失败（HTTP ${response.status}）`);
  const body = await readLimitedResponseText(response, webSearchMaxBytes);
  const parsed = duckDuckGoResults(body.text, response.url || url.href, args.count);
  if (parsed.challengeDetected || (!parsed.results.length && !parsed.explicitNoResults)) {
    throw new Error("DuckDuckGo 返回了拦截页或无法识别的搜索页面");
  }
  return {
    provider: "duckduckgo_html",
    query: args.query,
    alteredQuery: null,
    type: args.type,
    freshness: args.freshness,
    results: parsed.results,
    moreResultsAvailable: parsed.total > parsed.results.length,
  };
}

function normalizedNewsQuery(query: string): string {
  const withoutEnglishSuffix = query.replace(/\s+(?:latest|recent)\s+news\s*$/iu, "");
  const withoutChineseSuffix = withoutEnglishSuffix.replace(/\s*(?:最新|近期|最近)\s*(?:新闻|消息|资讯)\s*$/u, "");
  return withoutChineseSuffix.trim() || query;
}

function rssSearchRequest(args: WebSearchArgs): { provider: "bing_rss" | "google_news_rss"; url: URL; effectiveQuery: string } {
  const locale = defaultLocale(args.query);
  const country = args.country?.toUpperCase() ?? locale.country;
  const searchLanguage = args.searchLanguage?.toLowerCase() ?? locale.searchLanguage;
  if (args.type === "news") {
    const url = new URL(googleNewsSearchUrl);
    const freshness = googleNewsFreshness[args.freshness];
    const effectiveQuery = normalizedNewsQuery(args.query);
    url.searchParams.set("q", [effectiveQuery, freshness].filter(Boolean).join(" "));
    const chinese = searchLanguage?.startsWith("zh") ?? /[\u3400-\u9fff]/u.test(args.query);
    const region = country && country !== "ALL" ? country : chinese ? "CN" : "US";
    url.searchParams.set("hl", chinese ? "zh-CN" : "en-US");
    url.searchParams.set("gl", region);
    url.searchParams.set("ceid", `${region}:${chinese ? "zh-Hans" : "en"}`);
    return { provider: "google_news_rss", url, effectiveQuery };
  }

  const url = new URL(bingWebSearchUrl);
  url.searchParams.set("format", "rss");
  url.searchParams.set("q", args.query);
  if (searchLanguage) url.searchParams.set("setlang", searchLanguage);
  if (country && country !== "ALL") url.searchParams.set("cc", country);
  const freshness = bingFreshness[args.freshness];
  if (freshness) url.searchParams.set("filters", freshness);
  return { provider: "bing_rss", url, effectiveQuery: args.query };
}

async function runRssSearch(args: WebSearchArgs, signal: AbortSignal): Promise<WebSearchResponse> {
  const request = rssSearchRequest(args);
  const response = await fetch(request.url, {
    signal,
    redirect: "follow",
    headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": "OceanKing/1.0" },
  });
  if (!response.ok) throw new Error(`web_search 请求失败（HTTP ${response.status}）：公开 RSS 搜索源不可用`);
  const body = await readLimitedResponseText(response, webSearchMaxBytes);
  const parsed = rssResults(body.text, response.url || request.url.href, args.count);
  return {
    provider: request.provider,
    query: args.query,
    alteredQuery: request.effectiveQuery === args.query ? null : request.effectiveQuery,
    type: args.type,
    freshness: args.freshness,
    results: parsed.results,
    moreResultsAvailable: parsed.total > parsed.results.length,
  };
}

export async function runWebSearch(args: WebSearchArgs, signal: AbortSignal): Promise<WebSearchResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (apiKey) return runBraveSearch(args, signal, apiKey);
  if (args.type === "news") return runRssSearch(args, signal);
  try {
    return await runDuckDuckGoSearch(args, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return runRssSearch(args, signal);
  }
}

export function formatWebSearchResponse(response: WebSearchResponse): string {
  const heading = response.type === "news" ? "新闻搜索结果" : "网页搜索结果";
  const provider = response.provider === "brave"
    ? "Brave"
    : response.provider === "duckduckgo_html"
      ? "DuckDuckGo"
      : response.provider === "bing_rss"
        ? "Bing RSS"
        : "Google News RSS";
  const lines = [`${heading}（${provider}，查询：${response.alteredQuery ?? response.query}）`];
  if (!response.results.length) lines.push("没有找到可用结果。请调整搜索词或时间范围后重试。");
  for (const [index, result] of response.results.entries()) {
    const metadata = [result.source, result.publishedAt ?? result.age].filter(Boolean).join(" · ");
    lines.push(`${index + 1}. ${result.title}\nURL: ${result.url}${metadata ? `\n来源/时间: ${metadata}` : ""}${result.description ? `\n摘要: ${result.description}` : ""}`);
  }
  if (response.provider !== "brave") lines.push("当前使用零配置公开搜索源，适合本地个人检索；其稳定性、排序和可用范围不等同于正式搜索 API。");
  lines.push("这些条目是搜索摘要，不是已经核实的事实。涉及最新消息或重要结论时，继续用 web_fetch 打开具体 URL，至少核对两个独立来源，并在公开答案中保留来源链接；证据不足时必须明确说明。");
  return lines.join("\n\n");
}
