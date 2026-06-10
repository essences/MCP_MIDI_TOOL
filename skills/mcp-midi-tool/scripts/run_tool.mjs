#!/usr/bin/env node
import { createLocalToolClient } from "../lib/localToolClient.mjs";

const TOOL_NAME = process.env.TOOL_NAME;
const TOOL_ARGS_JSON = process.env.TOOL_ARGS_JSON || "{}";

async function main() {
  if (!TOOL_NAME) throw new Error("TOOL_NAME is required");
  const args = JSON.parse(TOOL_ARGS_JSON);
  const client = createLocalToolClient();
  try {
    await client.initialize({ name: "run-tool", version: "0.0.1" });
    const result = await client.callTool(TOOL_NAME, args);
    console.log(JSON.stringify({ ok: true, tool: TOOL_NAME, result }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error("[run_tool]", error?.stack || String(error));
  process.exitCode = 1;
});
