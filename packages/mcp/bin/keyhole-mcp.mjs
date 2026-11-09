#!/usr/bin/env node
// Runs the TypeScript sources through tsx (the guardian sources use TypeScript-only syntax that
// Node's type stripping does not accept). Behind an HTTP proxy, set NODE_USE_ENV_PROXY=1 so fetch
// uses HTTPS_PROXY. stdout is the MCP protocol; diagnostics go to stderr.
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/server.ts");
main().catch((e) => { console.error(`keyhole-mcp: ${e?.message ?? e}`); process.exit(1); });
