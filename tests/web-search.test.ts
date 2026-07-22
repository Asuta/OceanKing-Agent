import { afterEach, describe, expect, it, vi } from "vitest";
import { getToolDefinition } from "@/lib/server/tools";
import { packetFor, withRepository } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function executeSearch(raw: unknown) {
  let result: Awaited<ReturnType<NonNullable<ReturnType<typeof getToolDefinition>>["execute"]>> | undefined;
  await withRepository(async (repository) => {
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    result = await getToolDefinition("web_search")!.execute({
      agent,
      roomId: "room_harbor",
      agentParticipantId: "participant_navigator_harbor",
      packet,
      repository,
      signal: new AbortController().signal,
    }, raw, "call_web_search");
  });
  return result!;
}

describe("web_search", () => {
  it("未配置密钥时直接使用 DuckDuckGo 网页搜索", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
      void request;
      return new Response(`<!doctype html><html><body>
        <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">OceanKing 使用说明</a><div class="result__snippet">本地多 Agent 工作台</div></div>
        <div class="result"><a class="result__a" href="https://example.net/other">第二条结果</a><div class="result__snippet">另一条摘要</div></div>
      </body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeSearch({ query: "OceanKing", freshness: "week", count: 1 });
    expect(result.structured).toEqual(expect.objectContaining({
      provider: "duckduckgo_html",
      results: [expect.objectContaining({ title: "OceanKing 使用说明", url: "https://example.com/guide" })],
      moreResultsAvailable: true,
    }));
    expect(result.text).toContain("零配置公开搜索源");
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.hostname).toBe("html.duckduckgo.com");
    expect(url.searchParams.get("q")).toBe("OceanKing");
    expect(url.searchParams.get("df")).toBe("w");
  });

  it("DuckDuckGo 不可用时自动回退到 Bing RSS", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
      const url = new URL(String(request[0]));
      if (url.hostname === "html.duckduckgo.com") return new Response("temporarily unavailable", { status: 503 });
      return new Response(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0"><channel><item>
          <title>OceanKing 使用说明</title><link>https://example.com/guide</link><description>本地多 Agent 工作台</description>
        </item></channel></rss>`, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeSearch({ query: "OceanKing", count: 1 });
    expect(result.structured).toEqual(expect.objectContaining({
      provider: "bing_rss",
      results: [expect.objectContaining({ title: "OceanKing 使用说明" })],
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackUrl = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(fallbackUrl.hostname).toBe("www.bing.com");
    expect(fallbackUrl.searchParams.get("format")).toBe("rss");
  });

  it("DuckDuckGo 返回 HTTP 200 拦截页时自动回退到 Bing RSS", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
      const url = new URL(String(request[0]));
      if (url.hostname === "html.duckduckgo.com") {
        return new Response('<html><body><form id="challenge-form" action="//duckduckgo.com/anomaly.js"></form></body></html>', { status: 200 });
      }
      return new Response(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0"><channel><item>
          <title>备用搜索结果</title><link>https://example.com/fallback</link><description>来自 Bing RSS</description>
        </item></channel></rss>`, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeSearch({ query: "OceanKing", count: 1 });
    expect(result.structured).toEqual(expect.objectContaining({
      provider: "bing_rss",
      results: [expect.objectContaining({ title: "备用搜索结果" })],
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("DuckDuckGo 明确返回无结果时不误触发备用搜索", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    const fetchMock = vi.fn(async () => new Response(`<!doctype html><html><body>
      <div class="result result--no-result"><span class="no-results">No results found</span></div>
    </body></html>`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeSearch({ query: "不存在的精确搜索词" });
    expect(result.structured).toEqual(expect.objectContaining({ provider: "duckduckgo_html", results: [] }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("把网页搜索响应整理为受限的结构化来源", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-search-key");
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
      void request;
      return new Response(JSON.stringify({
        query: { original: "OceanKing", altered: "Ocean King" },
        web: {
          more_results_available: true,
          results: [
            {
              title: "<strong>OceanKing</strong> 项目",
              url: "https://example.com/oceanking",
              description: "一个  结构化搜索示例。",
              profile: { long_name: "Example Docs" },
              page_age: "2026-07-20T10:00:00Z",
            },
            { title: "无效协议", url: "javascript:alert(1)", description: "必须过滤" },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeSearch({ query: "OceanKing", type: "web", freshness: "week", count: 5, country: "ALL", searchLanguage: "zh-hans" });
    expect(result.structured).toEqual({
      provider: "brave",
      query: "OceanKing",
      alteredQuery: "Ocean King",
      type: "web",
      freshness: "week",
      results: [{
        title: "OceanKing 项目",
        url: "https://example.com/oceanking",
        description: "一个 结构化搜索示例。",
        source: "Example Docs",
        publishedAt: "2026-07-20T10:00:00Z",
        age: null,
      }],
      moreResultsAvailable: true,
    });
    expect(result.text).toContain("URL: https://example.com/oceanking");
    expect(result.text).toContain("至少核对两个独立来源");

    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe("/res/v1/web/search");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect(url.searchParams.get("count")).toBe("5");
    expect(url.searchParams.get("country")).toBe("ALL");
    expect(url.searchParams.get("search_lang")).toBe("zh-hans");
    expect(url.href).not.toContain("test-search-key");
    expect(new Headers(init?.headers).get("x-subscription-token")).toBe("test-search-key");
  });

  it("中文新闻搜索自动使用中文区域并保留来源时间", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-search-key");
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
      void request;
      return new Response(JSON.stringify({
        query: { original: "周星驰 最新新闻" },
        results: [{
          title: "电影项目公布新进展",
          url: "https://news.example.cn/article/1",
          description: "新闻正文摘要",
          source: { name: "示例新闻" },
          page_age: "2026-07-21T08:00:00Z",
          age: "2小时前",
        }],
        more_results_available: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeSearch({ query: "周星驰 最新新闻", type: "news", freshness: "day" });
    expect(result.structured).toEqual(expect.objectContaining({
      type: "news",
      alteredQuery: null,
      results: [expect.objectContaining({ source: "示例新闻", publishedAt: "2026-07-21T08:00:00Z" })],
    }));
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/res/v1/news/search");
    expect(url.searchParams.get("freshness")).toBe("pd");
    expect(url.searchParams.get("country")).toBe("CN");
    expect(url.searchParams.get("search_lang")).toBe("zh-hans");
    expect(url.searchParams.has("text_decorations")).toBe(false);
  });

  it("未配置密钥时使用 Google News RSS 搜索新闻", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
      void request;
      return new Response(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0"><channel><item>
          <title>电影项目公布新进展</title>
          <link>https://news.google.com/rss/articles/example</link>
          <description>&lt;a href="https://publisher.example/article"&gt;新闻正文摘要&lt;/a&gt;</description>
          <source>示例新闻</source>
          <pubDate>Tue, 21 Jul 2026 10:00:00 GMT</pubDate>
        </item></channel></rss>`, { status: 200, headers: { "content-type": "application/xml; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeSearch({ query: "周星驰 最新新闻", type: "news", freshness: "day", count: 5 });
    expect(result.structured).toEqual(expect.objectContaining({
      provider: "google_news_rss",
      alteredQuery: "周星驰",
      results: [expect.objectContaining({ source: "示例新闻", description: "新闻正文摘要" })],
    }));
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.hostname).toBe("news.google.com");
    expect(url.searchParams.get("q")).toBe("周星驰 when:1d");
    expect(url.searchParams.get("gl")).toBe("CN");
    expect(url.searchParams.get("ceid")).toBe("CN:zh-Hans");
  });

  it.each(["澎湃新闻", "BBC News"])("新闻搜索保留媒体名称：%s", async (query) => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
      void request;
      return new Response('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>', {
        status: 200,
        headers: { "content-type": "application/xml; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeSearch({ query, type: "news" });
    expect(result.structured).toEqual(expect.objectContaining({ alteredQuery: null }));
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("q")).toBe(query);
  });

  it("把搜索服务错误转换成工具错误且不泄露密钥", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "secret-search-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "rate limit reached" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    })));

    let message = "";
    try {
      await executeSearch({ query: "OceanKing" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 429");
    expect(message).toContain("rate limit reached");
    expect(message).not.toContain("secret-search-key");
  });
});
