import { handleRequest } from "./src/proxy.ts";

let kv: Deno.Kv | null = null;
let kvError: string | undefined;

try {
  kv = await Deno.openKv();
} catch (err) {
  kvError = err instanceof Error ? err.message : String(err);
  console.error("Failed to open KV. Logging will be disabled.", kvError);
}

Deno.serve((req) => handleRequest(req, kv, kvError));
