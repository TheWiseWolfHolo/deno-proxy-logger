export type Redacted<T> = T;

const SENSITIVE_KEY_RE =
  /^(?:authorization|proxy[_-]?token|token|api[_-]?key|key|access[_-]?token|refresh[_-]?token|secret|password)$/i;

const TOKEN_VALUE_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  { re: /\bBearer\s+([^\s]+)/gi, replace: "Bearer ***" },
  { re: /\bsk-[A-Za-z0-9]{16,}\b/g, replace: "sk-***" },
  { re: /\bAIza[0-9A-Za-z\-_]{16,}\b/g, replace: "AIza***" },
  {
    re: /\beyJ[A-Za-z0-9\-_]+?\.[A-Za-z0-9\-_]+?\.[A-Za-z0-9\-_]+\b/g,
    replace: "jwt_***",
  },
];

export function redactString(input: string): string {
  let out = input;
  for (const { re, replace } of TOKEN_VALUE_PATTERNS) out = out.replaceAll(re, replace);
  return out;
}

export function redactUrlForLog(url: URL): string {
  const u = new URL(url.toString());
  for (const [k] of u.searchParams) {
    if (SENSITIVE_KEY_RE.test(k)) u.searchParams.set(k, "***");
  }
  return u.pathname + (u.search ? u.search : "");
}

export function redactJson(value: unknown): Redacted<unknown> {
  const seen = new WeakMap<object, unknown>();

  const walk = (v: unknown): unknown => {
    if (v === null) return v;
    const t = typeof v;
    if (t === "string") return redactString(v);
    if (t !== "object") return v;

    const obj = v as object;
    const cached = seen.get(obj);
    if (cached) return cached;

    if (Array.isArray(v)) {
      const arr: unknown[] = [];
      seen.set(obj, arr);
      for (const item of v) arr.push(walk(item));
      return arr;
    }

    const rec = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    seen.set(obj, out);
    for (const [k, val] of Object.entries(rec)) {
      if (SENSITIVE_KEY_RE.test(k)) out[k] = "***";
      else out[k] = walk(val);
    }
    return out;
  };

  return walk(value);
}

export function clampUtf8Bytes(input: Uint8Array, maxBytes: number): {
  bytes: Uint8Array;
  truncated: boolean;
} {
  if (maxBytes <= 0) return { bytes: new Uint8Array(), truncated: input.byteLength > 0 };
  if (input.byteLength <= maxBytes) return { bytes: input, truncated: false };
  return { bytes: input.slice(0, maxBytes), truncated: true };
}

export async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (maxBytes <= 0) return { bytes: new Uint8Array(), truncated: true };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (size < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remaining = maxBytes - size;
      if (value.byteLength <= remaining) {
        chunks.push(value);
        size += value.byteLength;
        continue;
      }

      chunks.push(value.slice(0, remaining));
      size += remaining;
      truncated = true;
      break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  const out = concatChunks(chunks, size);
  return { bytes: out, truncated };
}

export function tryParseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  const text = new TextDecoder().decode(bytes).trim();
  if (!text) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function extractSummary(body: unknown): {
  summary?: string;
  model?: string;
  isStream?: boolean;
} {
  if (!body || typeof body !== "object") return {};
  const obj = body as Record<string, unknown>;
  const model = typeof obj.model === "string" ? obj.model : undefined;
  const isStream = typeof obj.stream === "boolean" ? obj.stream : undefined;

  // OpenAI: { messages: [{role, content}] }
  const messages = obj.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
    const content = last ? last.content : undefined;
    const text = contentToText(content);
    return { summary: text ? truncate(text, 220) : undefined, model, isStream };
  }

  // Gemini: { contents: [{ parts: [{text}] }] }
  const contents = obj.contents;
  if (Array.isArray(contents) && contents.length > 0) {
    const last = contents[contents.length - 1] as Record<string, unknown> | undefined;
    const parts = last ? last.parts : undefined;
    const text = partsToText(parts);
    return { summary: text ? truncate(text, 220) : undefined, model, isStream };
  }

  return { model, isStream };
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.text === "string") parts.push(rec.text);
  }
  const joined = parts.join("");
  return joined || undefined;
}

function partsToText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  const out: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const rec = p as Record<string, unknown>;
    if (typeof rec.text === "string") out.push(rec.text);
  }
  const joined = out.join("");
  return joined || undefined;
}

function truncate(s: string, maxChars: number): string {
  const t = s.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "…";
}

function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}


