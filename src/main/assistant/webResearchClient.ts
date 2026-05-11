import type { BackendResearchResult, DiagnosticEvent } from "../../shared/types";
import type { LlmClient } from "../llmClient";
import { now, safeError, truncate } from "../utils";

type DiagnosticSink = (event: Omit<DiagnosticEvent, "id" | "timestamp">) => void;

interface ResearchSource {
  title: string;
  url: string;
  snippet?: string;
  text?: string;
}

interface SummaryOutput {
  summary?: string;
  answer?: string;
}

export class WebResearchClient {
  constructor(
    private readonly llm?: LlmClient,
    private readonly diagnostics?: DiagnosticSink
  ) {}

  async research(query: string): Promise<BackendResearchResult> {
    const startedAt = now();
    this.log("research", "running", `开始联网查阅：${truncate(query, 80)}`);
    try {
      const urls = extractUrls(query);
      const sources = urls.length
        ? await Promise.all(urls.slice(0, 4).map((url) => this.fetchPage(url)))
        : await this.searchAndFetch(query);
      const summary = await this.summarize(query, sources);
      const result: BackendResearchResult = {
        query,
        summary,
        sources: sources.map((source) => ({
          title: source.title,
          url: source.url,
          snippet: source.snippet
        })),
        fetchedAt: now()
      };
      this.log("research", "ok", "联网查阅完成。", { elapsedMs: now() - startedAt, sourceCount: sources.length });
      return result;
    } catch (error) {
      this.log("research", "failed", safeError(error), { elapsedMs: now() - startedAt });
      throw error;
    }
  }

  private async searchAndFetch(query: string): Promise<ResearchSource[]> {
    const searchResults = await this.search(query);
    if (!searchResults.length) {
      throw new Error("没有找到可用搜索结果，需要更明确的关键词或链接。");
    }
    const pages: ResearchSource[] = [];
    for (const result of searchResults.slice(0, 4)) {
      try {
        pages.push(await this.fetchPage(result.url, result.title, result.snippet));
      } catch {
        pages.push(result);
      }
    }
    return dedupeSources(pages);
  }

  private async search(query: string): Promise<ResearchSource[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 phone-agent research"
      },
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error(`搜索失败：${response.status} ${response.statusText}`);
    const html = await response.text();
    const matches = [...html.matchAll(/<li class="b_algo"[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p>([\s\S]*?)<\/p>)?/g)];
    return matches
      .map((match) => ({
        url: decodeHtml(match[1]),
        title: cleanupText(stripHtml(match[2])) || decodeHtml(match[1]),
        snippet: cleanupText(stripHtml(match[3] ?? ""))
      }))
      .filter((item) => /^https?:\/\//i.test(item.url))
      .slice(0, 8);
  }

  private async fetchPage(url: string, titleHint?: string, snippet?: string): Promise<ResearchSource> {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 phone-agent research"
      },
      signal: AbortSignal.timeout(16000)
    });
    if (!response.ok) throw new Error(`网页读取失败：${response.status} ${response.statusText}`);
    const html = await response.text();
    const title = cleanupText(stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")) || titleHint || url;
    const text = cleanupText(stripHtml(html)).slice(0, 10000);
    return {
      title: truncate(title, 120),
      url,
      snippet: snippet || text.slice(0, 220),
      text
    };
  }

  private async summarize(query: string, sources: ResearchSource[]): Promise<string> {
    const fallback = localSummary(query, sources);
    if (!this.llm) return fallback;
    const model = await this.llm.completeJson<SummaryOutput>(
      "你是一个简洁可靠的信息整理助手，只返回 JSON。根据给定资料回答用户问题，避免编造，保留来源线索。",
      JSON.stringify({
        query,
        sources: sources.map((source) => ({
          title: source.title,
          url: source.url,
          snippet: source.snippet,
          text: source.text?.slice(0, 2200)
        }))
      }),
      { mode: "summary", timeoutMs: 45000, maxPromptChars: 7200 }
    );
    return cleanupWechatMessage(model?.summary ?? model?.answer ?? fallback);
  }

  private log(action: string, status: "running" | "ok" | "failed", message: string, payload?: unknown): void {
    this.diagnostics?.({
      source: "backend",
      category: "backend_tool",
      action,
      status,
      message: truncate(message, 240),
      payload
    });
  }
}

export function formatResearchResultForWechat(result: BackendResearchResult): string {
  const sourceText = result.sources
    .slice(0, 3)
    .map((source, index) => `${index + 1}. ${source.title} ${source.url}`)
    .join(" ");
  return cleanupWechatMessage(`${result.summary} 来源：${sourceText}`);
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s，。；;）)]+/g)].map((match) => match[0]);
}

function localSummary(query: string, sources: ResearchSource[]): string {
  const points = sources
    .slice(0, 3)
    .map((source) => source.snippet || source.text?.slice(0, 180) || source.title)
    .filter(Boolean)
    .join(" ");
  return cleanupWechatMessage(`我查到与“${query}”相关的资料：${points || "暂时没有足够正文可总结。"}。`);
}

function cleanupWechatMessage(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\n+/g, " ")
    .trim()
    .slice(0, 1800);
}

function stripHtml(html: string): string {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanupText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function dedupeSources(sources: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  const output: ResearchSource[] = [];
  for (const source of sources) {
    const key = source.url.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(source);
  }
  return output;
}
