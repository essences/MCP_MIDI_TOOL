#!/usr/bin/env node
import { createLocalToolClient } from "../lib/localToolClient.mjs";

async function main() {
  const client = createLocalToolClient();
  try {
    await client.initialize({ name: "list-all-tools", version: "0.0.1" });
    const tools = await client.listTools();
    console.log(JSON.stringify({
      ok: true,
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name)
    }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error("[list_all_tools]", error?.stack || String(error));
  process.exitCode = 1;
});
