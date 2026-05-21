#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "buildtools-mcp", version: "0.0.1" },
  { capabilities: { tools: {}, resources: {} } }
);

// Tools / resources will be registered in subsequent phases.

const transport = new StdioServerTransport();
await server.connect(transport);
