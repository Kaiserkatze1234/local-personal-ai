/**
 * Optional internet layer — spec §49. Isolated behind a config kill-switch
 * AND a permission ("network.access"); memory/project systems never depend
 * on these tools being present.
 */

import type { ToolResult } from '../../shared/types/tools.js';
import type { ConfigService } from '../core/config.js';
import type { ToolRegistry, ToolRunContext } from './registry.js';

const USER_AGENT = 'LocalPersonalAI/0.1 (personal assistant; opt-in retrieval only)';

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Returns an error ToolResult when the layer is off or the host is not allowed. */
function gate(config: ConfigService, urlRaw: string): { ok: true; url: URL } | { ok: false; result: ToolResult } {
  const cfg = config.get();
  if (!cfg.internet.enabled) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: 'Internet layer is disabled (Settings → Internet). Everything this app does without it stays local.',
        error: {
          kind: 'invalid_state',
          message: 'internet disabled',
          recovery: ['Enable "Internet access" under Settings if you want documentation lookup'],
        },
      },
    };
  }
  let url: URL;
  try {
    url = new URL(urlRaw);
  } catch {
    return { ok: false, result: { ok: false, summary: 'Invalid URL', error: { kind: 'user', message: 'not a URL' } } };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      result: { ok: false, summary: 'Only http(s) URLs allowed', error: { kind: 'user', message: 'scheme not allowed' } },
    };
  }
  const allowed = cfg.internet.allowedHosts;
  if (allowed.length > 0 && !allowed.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: `Host ${url.hostname} is not in the allowlist (Settings → Internet → allowed hosts).`,
        error: { kind: 'permission_denied', message: 'host not allowed' },
      },
    };
  }
  return { ok: true, url };
}

async function fetchCapped(
  url: string,
  signal: AbortSignal | undefined,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ text: string; contentType: string; truncated: boolean }> {
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort(new Error('cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    return { text: Buffer.from(buf).toString('utf8'), contentType: res.headers.get('content-type') ?? 'unknown', truncated };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function registerWebTools(registry: ToolRegistry, config: ConfigService): void {
  registry.register(
    {
      name: 'http_get',
      description:
        'Fetch one web page or API response as text. Only works when the optional internet layer is enabled in settings; use for documentation lookup.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, max_kb: { type: 'integer' } }, required: ['url'] },
      permission: 'network.access',
      mutating: false,
      phase: 14,
    },
    async (input, ctx: ToolRunContext): Promise<ToolResult> => {
      const gateR = gate(config, String(input.url ?? ''));
      if (!gateR.ok) return gateR.result;
      const maxKb = Math.min(1024, Number(input.max_kb) || config.get().internet.maxResponseKB);
      try {
        const fetched = await fetchCapped(gateR.url.toString(), ctx.signal, maxKb * 1024, 20_000);
        const isHtml = fetched.contentType.includes('html') || /^\s*</.test(fetched.text);
        const isJson = fetched.contentType.includes('json');
        const body = isHtml ? stripHtml(fetched.text) : fetched.text;
        const content = body.length > maxKb * 1024 ? `${body.slice(0, maxKb * 1024)}…` : body;
        return {
          ok: true,
          summary: `Fetched ${gateR.url.hostname}${isJson ? ' (json)' : isHtml ? ' (page text)' : ''}${fetched.truncated ? ', truncated' : ''}`,
          data: {
            contentType: isJson ? 'json' : isHtml ? 'text' : 'raw',
            content: content.slice(0, 200_000),
            truncated: fetched.truncated || undefined,
          },
        };
      } catch (err) {
        const msg = (err as Error).message === 'timeout' ? 'request timed out (20s)' : (err as Error).message;
        return {
          ok: false,
          summary: `Fetch failed: ${msg}`,
          error: { kind: 'provider', message: msg, recovery: ['Check connectivity or add the host to the allowlist'] },
        };
      }
    },
  );

  registry.register(
    {
      name: 'web_search',
      description:
        'Keyless DuckDuckGo search returning titles/snippets/links for documentation and software information. Optional layer — only works when internet access is enabled in settings.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['query'],
      },
      permission: 'network.access',
      mutating: false,
      phase: 14,
    },
    async (input, ctx: ToolRunContext): Promise<ToolResult> => {
      const query = String(input.query ?? '').trim();
      if (!query) return { ok: false, summary: 'Empty query', error: { kind: 'user', message: 'query required' } };
      const gateR = gate(config, 'https://duckduckgo.com/html/?q=x');
      if (!gateR.ok) return gateR.result;
      const limit = Math.min(10, Number(input.limit) || 5);
      try {
        const fetched = await fetchCapped(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, ctx.signal, 800 * 1024, 20_000);
        const results: { title: string; url: string; snippet: string }[] = [];
        const blockRe =
          /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g;
        let m: RegExpExecArray | null;
        while ((m = blockRe.exec(fetched.text)) !== null && results.length < limit) {
          const href = m[1] ?? '';
          const u = /uddg=([^&]+)/.exec(href);
          results.push({
            title: stripHtml(m[2] ?? '').slice(0, 160),
            url: u?.[1] ? decodeURIComponent(u[1]) : href,
            snippet: stripHtml(m[3] ?? '').slice(0, 240),
          });
        }
        if (results.length === 0)
          return { ok: true, summary: 'Search returned no parseable results (page format may have changed)', data: { results: [] } };
        return { ok: true, summary: `${results.length} result(s) for "${query.slice(0, 60)}"`, data: { results } };
      } catch (err) {
        return {
          ok: false,
          summary: `Search failed: ${(err as Error).message}`,
          error: { kind: 'provider', message: (err as Error).message },
        };
      }
    },
  );
}
