import { handleRequest } from "./src/proxy.ts";

const kv = await Deno.openKv();

Deno.serve((req) => handleRequest(req, kv));


