import { Readability } from "@mozilla/readability";
import { decode, encode } from "gpt-tokenizer/encoding/o200k_base";
import { JSDOM } from "jsdom";

export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_MAX_TOKENS = 4_000;

const ignoredElements = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "footer",
  "form",
  "dialog",
].join(",");

const blockElements = [
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "p",
  "pre",
  "section",
  "table",
  "tr",
].join(",");

export type ExtractedWebContent = {
  text: string;
  title: string | null;
  extraction: "readability" | "fallback" | "plain_text";
};

export type LimitedWebContent = {
  text: string;
  tokenCount: number;
  originalTokenCount: number;
  truncated: boolean;
};

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderDocument(document: Document): string {
  for (const element of Array.from(document.querySelectorAll(ignoredElements))) element.remove();

  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const label = normalizeText(anchor.textContent ?? "");
    let href = "";
    try {
      const resolved = new URL(anchor.getAttribute("href") ?? "", document.baseURI);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") href = resolved.href;
    } catch {
      // Invalid and non-HTTP links are omitted from model context.
    }
    const replacement = label && href && label !== href ? `${label} (${href})` : label || href;
    anchor.replaceWith(document.createTextNode(replacement));
  }

  for (const image of Array.from(document.querySelectorAll("img[alt]"))) {
    image.replaceWith(document.createTextNode(normalizeText(image.getAttribute("alt") ?? "")));
  }
  for (const lineBreak of Array.from(document.querySelectorAll("br"))) lineBreak.replaceWith(document.createTextNode("\n"));
  for (const cell of Array.from(document.querySelectorAll("th, td"))) cell.append(document.createTextNode("\t"));
  for (const block of Array.from(document.querySelectorAll(blockElements))) block.append(document.createTextNode("\n\n"));

  return normalizeText(document.body?.textContent ?? document.documentElement.textContent ?? "");
}

function withTitle(title: string | null, text: string): string {
  const normalizedTitle = normalizeText(title ?? "");
  if (!normalizedTitle || text.startsWith(normalizedTitle)) return text;
  return `${normalizedTitle}\n\n${text}`;
}

export function extractWebContent(raw: string, contentType: string | null, url: string): ExtractedWebContent {
  const isHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType ?? "")
    || /^\s*(?:<!doctype\s+html|<html\b)/i.test(raw);
  if (!isHtml) return { text: raw.trim(), title: null, extraction: "plain_text" };

  const dom = new JSDOM(raw, { url });
  const article = new Readability(dom.window.document).parse();
  if (article?.content && normalizeText(article.textContent ?? "").length > 0) {
    const articleDom = new JSDOM(article.content, { url });
    return {
      text: withTitle(article.title ?? null, renderDocument(articleDom.window.document)),
      title: normalizeText(article.title ?? "") || null,
      extraction: "readability",
    };
  }

  const fallbackDom = new JSDOM(raw, { url });
  const title = normalizeText(fallbackDom.window.document.title) || null;
  return {
    text: withTitle(title, renderDocument(fallbackDom.window.document)),
    title,
    extraction: "fallback",
  };
}

export function limitWebContentTokens(text: string, maxTokens = WEB_FETCH_MAX_TOKENS): LimitedWebContent {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) {
    return { text, tokenCount: tokens.length, originalTokenCount: tokens.length, truncated: false };
  }

  const marker = `\n\n[网页正文已截断，最多返回 ${maxTokens} tokens]`;
  const markerTokens = encode(marker);
  const contentBudget = Math.max(0, maxTokens - markerTokens.length);
  const limitedText = `${decode(tokens.slice(0, contentBudget)).trimEnd()}${marker}`;
  return {
    text: limitedText,
    tokenCount: encode(limitedText).length,
    originalTokenCount: tokens.length,
    truncated: true,
  };
}

function charsetFromContentType(contentType: string | null): string {
  return contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
}

export async function readLimitedResponseText(response: Response, maxBytes = WEB_FETCH_MAX_BYTES): Promise<{ text: string; bytes: number }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`网页响应超过 ${maxBytes} 字节上限`);
  }
  if (!response.body) return { text: "", bytes: 0 };

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`网页响应超过 ${maxBytes} 字节上限`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetFromContentType(response.headers.get("content-type")));
  } catch {
    decoder = new TextDecoder();
  }
  return { text: decoder.decode(body), bytes };
}

export function isSupportedWebContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  return /^text\//i.test(contentType)
    || /(?:json|xml|javascript|xhtml\+xml|x-www-form-urlencoded)/i.test(contentType);
}
