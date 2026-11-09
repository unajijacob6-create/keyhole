// @keyhole/mcp — a stdio MCP server that gives an AI agent Keyhole's trust check before it moves
// money on NEAR. Read-only: no tool takes a key, signs, or sends a transaction.
//
//   npm run mcp                      (or: npx tsx packages/mcp/src/server.ts, or the keyhole-mcp bin)
//
// Tools (packages/mcp/src/tools.ts): keyhole_inspect, keyhole_pending, keyhole_check_call,
// keyhole_verify_hatch. Results are JSON text with the evidence fields Keyhole produces.
// stdout carries the MCP protocol only; diagnostics go to stderr.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, defaultDeps, type McpDeps } from "./tools.ts";

export const SERVER_INFO = { name: "keyhole", version: "0.1.0" };

export const INSTRUCTIONS =
  "Keyhole answers one question before an agent deposits into a NEAR contract: who can change this code, and is an upgrade about to land? " +
  "Call keyhole_check_call before a deposit (OK: proceed; CAUTION: ask the human; STOP: do not proceed). keyhole_inspect explains the live code's grade, keyhole_pending the upgrades that have not executed yet. " +
  "Verdicts describe trust assumptions from public on-chain data; they do not accuse anyone, and a STOP is a grade, not proof of malice. All tools are read-only.";

/** Minimal JSON-schema check for the subset the tools use (types, required, enum, pattern, bounds,
 *  no extra properties). The low-level SDK server does not validate tool input itself. */
export function validate(schema: { properties: Record<string, any>; required?: string[] }, args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const a = args as Record<string, unknown>;
  for (const k of schema.required ?? []) if (a[k] === undefined) return `missing required argument: ${k}`;
  for (const [k, v] of Object.entries(a)) {
    const s = schema.properties[k];
    if (!s) return `unknown argument: ${k}`;
    if (v === undefined) continue;
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    const t = Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v;
    if (!types.some((x) => x === t || (x === "number" && t === "integer"))) return `${k} must be ${types.join(" or ")}`;
    if (s.enum && !s.enum.includes(v)) return `${k} must be one of ${s.enum.join(", ")}`;
    if (typeof v === "string") {
      if (s.pattern && !new RegExp(s.pattern).test(v)) return `${k} is not valid`;
      if (s.minLength !== undefined && v.length < s.minLength) return `${k} is too short`;
      if (s.maxLength !== undefined && v.length > s.maxLength) return `${k} is too long`;
    }
    if (typeof v === "number" && ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum))) return `${k} is out of range`;
  }
  return null;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export function createServer(overrides: Partial<McpDeps> = {}): Server {
  const deps: McpDeps = { ...defaultDeps(), ...overrides };
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: t.name !== "keyhole_verify_hatch" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: "text", text: `unknown tool: ${req.params.name}` }] };
    const args = req.params.arguments ?? {};
    const bad = validate(tool.inputSchema, args);
    if (bad) return { isError: true, content: [{ type: "text", text: `${tool.name}: ${bad}` }] };
    try {
      return { content: [{ type: "text", text: json(await tool.run(args, deps)) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `${tool.name} failed: ${String((e as Error)?.message ?? e).slice(0, 500)}` }] };
    }
  });
  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`keyhole-mcp ${SERVER_INFO.version}: ${TOOLS.length} read-only tools on stdio`);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`keyhole-mcp: ${e?.message ?? e}`);
    process.exit(1);
  });
}
