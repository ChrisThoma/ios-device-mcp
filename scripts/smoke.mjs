// Smoke test over stdio: SHOTS=/tmp node scripts/smoke.mjs '<json list of [tool, args]>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env }, stderr: "inherit" }));
const steps = JSON.parse(process.argv[2]);
let n = 0;
for (const [tool, args] of steps) {
  if (tool === "sleep") { await new Promise((r) => setTimeout(r, args.ms)); continue; }
  const t = Date.now();
  const res = await client.callTool({ name: tool, arguments: args ?? {} }, undefined, { timeout: 600000 });
  console.log(`\n=== ${tool} ${JSON.stringify(args ?? {})} (${Date.now() - t}ms)${res.isError ? " ERROR" : ""}`);
  for (const c of res.content) {
    if (c.type === "image") { const p = `${process.env.SHOTS}/shot${n++}.jpg`; writeFileSync(p, Buffer.from(c.data, "base64")); console.log(`[image -> ${p}]`); }
    else console.log(c.text.length > Number(process.env.MAXOUT ?? 3000) ? c.text.slice(0, 3000) + "\n…" : c.text);
  }
}
await client.close();
