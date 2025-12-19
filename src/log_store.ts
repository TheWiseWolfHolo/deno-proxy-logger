export interface LogEntry {
  id: string;
  ts: number;
  method: string;
  path: string; // 已脱敏（仅 pathname+search）

  upstreamBaseUrl: string;
  status: number;
  durationMs: number;

  request: {
    truncated: boolean;
    bodyText?: string; // 已脱敏/截断
    bodyJson?: unknown; // 已脱敏
    summary?: string;
    model?: string;
    isStream?: boolean;
  };

  response: {
    truncated: boolean;
    snippetText?: string; // 已脱敏/截断
    stream: boolean;
    aborted?: boolean;
  };

  error?: string;
}

export class LogStore {
  constructor(private kv: Deno.Kv) {}

  async put(entry: LogEntry): Promise<void> {
    const timeKey: Deno.KvKey = ["log", entry.ts, entry.id];
    const idKey: Deno.KvKey = ["logById", entry.id];

    const atomic = this.kv.atomic()
      .set(timeKey, entry)
      .set(idKey, entry);
    const res = await atomic.commit();
    if (!res.ok) throw new Error("KV commit failed");
  }

  async get(id: string): Promise<LogEntry | null> {
    const res = await this.kv.get<LogEntry>(["logById", id]);
    return res.value ?? null;
  }

  async list(params: { limit: number; before?: number }): Promise<LogEntry[]> {
    const limit = clampLimit(params.limit);
    const before = params.before;

    const selector: Deno.KvListSelector =
      typeof before === "number" && Number.isFinite(before)
        ? { prefix: ["log"], end: ["log", before] }
        : { prefix: ["log"] };

    const options: Deno.KvListOptions = { limit, reverse: true };

    const out: LogEntry[] = [];
    for await (const item of this.kv.list<LogEntry>(selector, options)) {
      if (item.value) out.push(item.value);
    }
    return out;
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(200, Math.max(1, Math.floor(limit)));
}
