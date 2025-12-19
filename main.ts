import { handleRequest } from "./src/proxy.ts";

type KvState = {
  kv: Deno.Kv | null;
  kvError?: string;
  openPromise: Promise<Deno.Kv | null> | null;
};

const kvState: KvState = {
  kv: null,
  openPromise: null,
};

function openKvOnce(): Promise<Deno.Kv | null> {
  if (kvState.openPromise) return kvState.openPromise;

  kvState.openPromise = (async () => {
    try {
      const kv = await Deno.openKv();
      kvState.kv = kv;
      return kv;
    } catch (err) {
      kvState.kvError = err instanceof Error ? err.message : String(err);
      kvState.kv = null;
      console.error(
        "Failed to open KV. Logging will be disabled.",
        kvState.kvError,
      );
      return null;
    }
  })();

  return kvState.openPromise;
}

async function getKvWithTimeout(ms: number): Promise<Deno.Kv | null> {
  if (kvState.kv) return kvState.kv;
  const open = openKvOnce();
  const timed = await Promise.race([
    open,
    delay(ms).then(() => null),
  ]);
  return timed ?? kvState.kv;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.serve(async (req) => {
  // 关键：不要在启动阶段卡死（Deploy 可能会对启动时间有超时）
  // KV 采用懒加载 + 超时兜底：没绑定 KV 也能先把代理跑起来。
  const kv = await getKvWithTimeout(300);
  return handleRequest(req, kv, kvState.kvError);
});
