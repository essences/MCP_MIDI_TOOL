import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Minimal MCP server with no tools yet, only handshake/info
async function main() {
  const transport = new StdioServerTransport();
  const server = new Server(
    { name: "mcp-midi-tool", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // No tools registered yet (intentionally empty for TDD start)

  await server.connect(transport);

  // Keep process alive until client closes the connection
  await new Promise<void>((resolve, reject) => {
    transport.onclose = () => resolve();
  transport.onerror = (err: Error) => reject(err);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
