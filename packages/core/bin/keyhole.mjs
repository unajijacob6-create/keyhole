#!/usr/bin/env node
// Node >= 22.18 runs the TypeScript sources directly (type stripping). Behind an HTTP proxy, set
// NODE_USE_ENV_PROXY=1 so fetch uses HTTPS_PROXY.
import { main } from "../src/cli.ts";
main().then((code) => process.exit(code ?? 0), (e) => { console.error(`keyhole: ${e?.message ?? e}`); process.exit(1); });
