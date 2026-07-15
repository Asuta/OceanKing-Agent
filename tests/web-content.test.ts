import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getToolDefinition } from "@/lib/server/tools";
import {
  extractWebContent,
  isSupportedWebContentType,
  limitWebContentTokens,
  readLimitedResponseText,
  WEB_FETCH_MAX_TOKENS,
} from "@/lib/server/web-content";
import { packetFor, withRepository } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const articleHtml = `<!doctype html>
<html>
  <head><title>海洋观测报告</title><style>.hidden { display: none }</style></head>
  <body>
    <nav>${"导航噪声".repeat(200)}</nav>
    <script>window.__noise = "脚本噪声";</script>
    <article>
      <h1>海洋观测报告</h1>
      <p>${"今天记录到稳定的潮汐变化，这是需要保留的正文。".repeat(20)}</p>
      <p><a href="/source">查看原始数据</a></p>
    </article>
    <footer>${"页脚噪声".repeat(200)}</footer>
  </body>
</html>`;

describe("web_fetch 内容治理", () => {
  it("从 HTML 中提取正文、移除页面噪声并保留绝对链接", () => {
    const result = extractWebContent(articleHtml, "text/html; charset=utf-8", "https://example.com/reports/tide");

    expect(result.extraction).toBe("readability");
    expect(result.text).toContain("稳定的潮汐变化");
    expect(result.text).toContain("查看原始数据 (https://example.com/source)");
    expect(result.text).not.toContain("导航噪声");
    expect(result.text).not.toContain("脚本噪声");
    expect(result.text).not.toContain("页脚噪声");
  });

  it("按 Token 而不是字符数限制返回正文", () => {
    const result = limitWebContentTokens("中文网页正文。".repeat(10_000));

    expect(result.truncated).toBe(true);
    expect(result.originalTokenCount).toBeGreaterThan(WEB_FETCH_MAX_TOKENS);
    expect(result.tokenCount).toBeLessThanOrEqual(WEB_FETCH_MAX_TOKENS);
    expect(countTokens(result.text)).toBeLessThanOrEqual(WEB_FETCH_MAX_TOKENS);
    expect(result.text).toContain("网页正文已截断");
  });

  it("在流式读取阶段拒绝超过字节上限的响应", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    }), { headers: { "content-type": "text/plain" } });

    await expect(readLimitedResponseText(response, 10)).rejects.toThrow("超过 10 字节上限");
  });

  it("拒绝图片等二进制响应", () => {
    expect(isSupportedWebContentType("image/png")).toBe(false);
    expect(isSupportedWebContentType("application/pdf")).toBe(false);
    expect(isSupportedWebContentType("application/json; charset=utf-8")).toBe(true);
  });

  it("非 HTML 文本不会因清理而改变内容语义", () => {
    const json = '{"message":"需要    保留空格","items":[1, 2]}';
    expect(extractWebContent(json, "application/json", "https://example.com/data").text).toBe(json);
  });

  it("web_fetch 返回清理后的受限文本和压缩元数据", async () => withRepository(async (repository) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(articleHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 200,
    })));
    const agent = repository.getAgent("navigator")!;
    const packet = packetFor(repository);
    const result = await getToolDefinition("web_fetch")!.execute({
      agent,
      roomId: "room_harbor",
      agentParticipantId: "participant_navigator_harbor",
      packet,
      repository,
      signal: new AbortController().signal,
    }, { url: "https://93.184.216.34/reports/tide" }, "call_web_fetch");

    expect(result.text).toContain("稳定的潮汐变化");
    expect(result.text).not.toContain("脚本噪声");
    expect(result.structured).toEqual(expect.objectContaining({
      extraction: "readability",
      truncated: false,
      tokens: expect.any(Number),
      bytes: expect.any(Number),
    }));
  }));
});
