import { LogStore, type LogEntry } from "./log_store.ts";
import {
  extractSummary,
  readStreamLimited,
  redactJson,
  redactString,
  redactUrlForLog,
  tryParseJson,
} from "./redact.ts";
import { renderLogDetailPage, renderLoginPage, renderLogsPage } from "./ui.ts";

const DEFAULT_UPSTREAM_BASE_URL = "https://wolfholo-gcli.zeabur.app";
const COOKIE_NAME = "proxy_token";

export async function handleRequest(req: Request, kv: Deno.Kv): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // UI / API
  if (url.pathname === "/") return redirect("/logs");
  if (url.pathname === "/health") return json({ ok: true });
  if (url.pathname === "/login") return handleLogin(req);
  if (url.pathname === "/logout") return handleLogout(req);
  if (url.pathname === "/logs" || url.pathname.startsWith("/logs/")) {
    const auth = checkAuth(req);
    if (!auth.ok) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return await handleLogsUi(req, kv);
  }
  if (url.pathname === "/api/logs" || url.pathname.startsWith("/api/logs/")) {
    const auth = checkAuth(req);
    if (!auth.ok) return withCors(json({ error: "unauthorized" }, 401));
    return await handleLogsApi(req, kv);
  }

  // Proxy (默认路径)
  const auth = checkAuth(req);
  if (!auth.ok) return withCors(json({ error: "unauthorized" }, 401));
  return await handleProxy(req, kv);
}

async function handleProxy(req: Request, kv: Deno.Kv): Promise<Response> {
  const upstreamBaseUrl = Deno.env.get("UPSTREAM_BASE_URL") ?? DEFAULT_UPSTREAM_BASE_URL;
  const upstreamKey = Deno.env.get("UPSTREAM_KEY") ?? "";
  if (!upstreamKey) return withCors(json({ error: "missing UPSTREAM_KEY" }, 500));

  const incomingUrl = new URL(req.url);
  const upstreamUrl = buildUpstreamUrl(upstreamBaseUrl, incomingUrl);
  maybeInjectGeminiKey(upstreamUrl, upstreamKey);

  const maxLogBytes = getIntEnv("MAX_LOG_BYTES", 32768);
  const shouldLogResponse = (Deno.env.get("LOG_RESPONSE") ?? "1") !== "0";

  // 并行读取（clone 的 body）用于落库，不影响原始 body 转发
  const requestBodyPromise = readRequestBodyForLog(req, maxLogBytes);

  const headers = new Headers(req.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.set("authorization", `Bearer ${upstreamKey}`);

  const method = req.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = req.body ?? null;
  }

  const start = Date.now();
  const store = new LogStore(kv);
  const id = crypto.randomUUID();
  const pathForLog = redactUrlForLog(incomingUrl);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl.toString(), init);
  } catch (err) {
    const durationMs = Date.now() - start;
    const reqLog = await buildRequestLog(requestBodyPromise);
    const entry: LogEntry = {
      id,
      ts: start,
      method,
      path: pathForLog,
      upstreamBaseUrl,
      status: 502,
      durationMs,
      request: reqLog,
      response: { truncated: false, stream: false },
      error: err instanceof Error ? err.message : String(err),
    };
    try {
      await store.put(entry);
    } catch {
      // ignore
    }
    return withCors(json({ error: "upstream_fetch_failed" }, 502));
  }

  const resHeaders = mergeHeaders(new Headers(upstreamResp.headers), corsHeaders());

  // 无 body（例如 HEAD）
  if (!upstreamResp.body) {
    const durationMs = Date.now() - start;
    const reqLog = await buildRequestLog(requestBodyPromise);
    const entry: LogEntry = {
      id,
      ts: start,
      method,
      path: pathForLog,
      upstreamBaseUrl,
      status: upstreamResp.status,
      durationMs,
      request: reqLog,
      response: { truncated: false, stream: false },
    };
    try {
      await store.put(entry);
    } catch {
      // ignore
    }
    return new Response(null, { status: upstreamResp.status, headers: resHeaders });
  }

  const body = createLoggedProxyStream(
    upstreamResp.body,
    shouldLogResponse ? maxLogBytes : 0,
    async (meta) => {
      const durationMs = Date.now() - start;
      const reqLog = await buildRequestLog(requestBodyPromise);
      const responseSnippet = shouldLogResponse ? redactString(meta.snippetText()) : undefined;
      const entry: LogEntry = {
        id,
        ts: start,
        method,
        path: pathForLog,
        upstreamBaseUrl,
        status: upstreamResp.status,
        durationMs,
        request: reqLog,
        response: {
          truncated: meta.truncated,
          stream: true,
          aborted: meta.aborted,
          snippetText: responseSnippet,
        },
      };
      try {
        await store.put(entry);
      } catch {
        // ignore
      }
    },
  );

  return new Response(body, { status: upstreamResp.status, headers: resHeaders });
}

async function handleLogsUi(req: Request, kv: Deno.Kv): Promise<Response> {
  const url = new URL(req.url);
  const store = new LogStore(kv);

  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  if (url.pathname === "/logs") {
    const limit = getIntParam(url, "limit", 50);
    const before = getIntParam(url, "before", undefined);
    const logs = await store.list({ limit, before });
    const nextBefore = logs.length === limit ? logs[logs.length - 1]?.ts : undefined;
    return html(renderLogsPage({ logs, nextBefore }));
  }

  const id = url.pathname.slice("/logs/".length);
  const log = await store.get(id);
  if (!log) return new Response("Not Found", { status: 404 });
  return html(renderLogDetailPage({ log }));
}

async function handleLogsApi(req: Request, kv: Deno.Kv): Promise<Response> {
  const url = new URL(req.url);
  const store = new LogStore(kv);
  if (req.method !== "GET") return withCors(json({ error: "method_not_allowed" }, 405));

  if (url.pathname === "/api/logs") {
    const limit = getIntParam(url, "limit", 50);
    const before = getIntParam(url, "before", undefined);
    const logs = await store.list({ limit, before });
    return withCors(json({ logs }, 200));
  }

  const id = url.pathname.slice("/api/logs/".length);
  const log = await store.get(id);
  if (!log) return withCors(json({ error: "not_found" }, 404));
  return withCors(json({ log }, 200));
}

function handleLogin(req: Request): Response {
  const url = new URL(req.url);
  const token = (url.searchParams.get("t") ?? "").trim();
  const next = (url.searchParams.get("next") ?? "/logs").trim() || "/logs";

  const expected = Deno.env.get("PROXY_TOKEN") ?? "";
  if (!expected) {
    return html(renderLoginPage({ next, message: "服务端未配置 PROXY_TOKEN" }), 500);
  }

  if (!token) {
    return html(renderLoginPage({ next }));
  }

  if (token !== expected) {
    return html(renderLoginPage({ next, message: "token 不正确" }), 401);
  }

  return redirect(next, {
    "Set-Cookie": buildAuthCookie(token, req),
  });
}

function handleLogout(req: Request): Response {
  return redirect("/login?next=%2Flogs", {
    "Set-Cookie": clearAuthCookie(req),
  });
}

function checkAuth(req: Request): { ok: true } | { ok: false } {
  const expected = (Deno.env.get("PROXY_TOKEN") ?? "").trim();
  if (!expected) return { ok: false };

  const fromHeader = readBearerToken(req.headers.get("authorization"));
  if (fromHeader && safeEqual(fromHeader, expected)) return { ok: true };

  const cookies = parseCookies(req.headers.get("cookie"));
  const fromCookie = cookies[COOKIE_NAME];
  if (fromCookie && safeEqual(fromCookie, expected)) return { ok: true };

  return { ok: false };
}

async function readRequestBodyForLog(
  req: Request,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const clone = req.clone();
  if (!clone.body) return { bytes: new Uint8Array(), truncated: false };
  return await readStreamLimited(clone.body, maxBytes);
}

async function buildRequestLog(
  reqBodyPromise: Promise<{ bytes: Uint8Array; truncated: boolean }>,
): Promise<LogEntry["request"]> {
  const { bytes, truncated } = await reqBodyPromise;
  if (!bytes || bytes.byteLength === 0) return { truncated };

  const parsed = tryParseJson(bytes);
  if (!parsed.ok) {
    const text = redactString(new TextDecoder().decode(bytes));
    return { truncated, bodyText: text };
  }

  const redacted = redactJson(parsed.value);
  const summary = extractSummary(redacted);
  return {
    truncated,
    bodyJson: redacted,
    summary: summary.summary,
    model: summary.model,
    isStream: summary.isStream,
  };
}

function createLoggedProxyStream(
  upstreamBody: ReadableStream<Uint8Array>,
  maxCaptureBytes: number,
  onDone: (meta: { truncated: boolean; aborted: boolean; snippetText: () => string }) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let captured = 0;

  const meta = {
    truncated: false,
    aborted: false,
    snippetText: () => parts.join(""),
  };

  let finished = false;
  const finishOnce = async () => {
    if (finished) return;
    finished = true;
    if (maxCaptureBytes > 0) {
      try {
        parts.push(decoder.decode());
      } catch {
        // ignore
      }
    }
    try {
      await onDone(meta);
    } catch {
      // ignore
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          await finishOnce();
          controller.close();
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
          return;
        }
        if (!value) return;

        if (maxCaptureBytes > 0 && captured < maxCaptureBytes) {
          const remaining = maxCaptureBytes - captured;
          if (value.byteLength <= remaining) {
            parts.push(decoder.decode(value, { stream: true }));
            captured += value.byteLength;
          } else {
            parts.push(decoder.decode(value.slice(0, remaining), { stream: true }));
            captured += remaining;
            meta.truncated = true;
          }
        } else if (maxCaptureBytes > 0) {
          meta.truncated = true;
        }

        controller.enqueue(value);
      } catch (e) {
        await finishOnce();
        controller.error(e);
      }
    },
    async cancel(reason) {
      meta.aborted = true;
      try {
        await reader.cancel(reason);
      } catch {
        // ignore
      }
      try {
        await finishOnce();
      } catch {
        // ignore
      }
    },
  });
}

function buildUpstreamUrl(base: string, incoming: URL): URL {
  const baseUrl = new URL(base);
  baseUrl.pathname = joinPath(baseUrl.pathname, incoming.pathname);
  baseUrl.search = incoming.search;
  return baseUrl;
}

function joinPath(basePath: string, extraPath: string): string {
  const a = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const b = extraPath.startsWith("/") ? extraPath : `/${extraPath}`;
  if (a === "") return b;
  return a + b;
}

function maybeInjectGeminiKey(url: URL, key: string): void {
  // Gemini 原生 REST 常用 ?key=...；做一个“尽量兼容”的自动注入（不影响 OpenAI 路径）
  const p = url.pathname;
  const looksLikeGemini = p.includes(":generateContent") || p.includes(":streamGenerateContent");
  if (!looksLikeGemini) return;
  if (!url.searchParams.has("key")) url.searchParams.set("key", key);
}

function getIntEnv(name: string, fallback: number): number {
  const raw = (Deno.env.get(name) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function getIntParam(url: URL, name: string, fallback: number | undefined): number | undefined {
  const raw = (url.searchParams.get(name) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: h });
}

function html(content: string, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  return new Response(content, { status, headers: h });
}

function redirect(location: string, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("location", location);
  return new Response(null, { status: 302, headers: h });
}

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  };
}

function withCors(resp: Response): Response {
  const h = mergeHeaders(new Headers(resp.headers), corsHeaders());
  return new Response(resp.body, { status: resp.status, headers: h });
}

function mergeHeaders(base: Headers, extra: HeadersInit): Headers {
  const h = new Headers(base);
  const e = new Headers(extra);
  for (const [k, v] of e.entries()) h.set(k, v);
  return h;
}

function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function buildAuthCookie(token: string, req: Request): string {
  const url = new URL(req.url);
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000;${secure}`;
}

function clearAuthCookie(req: Request): string {
  const url = new URL(req.url);
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0;${secure}`;
}

function safeEqual(a: string, b: string): boolean {
  // 简单常量时间比较（长度不同时也走同样循环）
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(aa.length, bb.length);
  let out = 0;
  for (let i = 0; i < len; i++) {
    out |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return out === 0 && a.length === b.length;
}


