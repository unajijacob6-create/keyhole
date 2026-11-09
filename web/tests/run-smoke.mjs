// Starts `vite preview` for the built site, runs the smoke test against it, then stops it.
import { spawn } from "node:child_process";
const server = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore", detached: true });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch("http://localhost:4173/keyhole/")).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const test = spawn("node", [new URL("smoke.mjs", import.meta.url).pathname], { stdio: "inherit" });
const code = await new Promise((r) => test.on("exit", r));
try { process.kill(-server.pid); } catch {}
process.exit(code ?? 1);
