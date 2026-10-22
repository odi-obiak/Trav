// Local stand-in for Vercel, for tests and local runs of the PAP functions: applies vercel.json rewrites,
// parses JSON and form bodies, and gives handlers Vercel's req.query / res.status().json().
// Run: PAP_TOKEN_SECRET=... PAP_ALLOWED_CLIENTS=... AISA_REST_URL=... node pap/dev-server.js [port]
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REWRITES = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")).rewrites || [];

function rewrite(pathname) {
  for (const { source, destination } of REWRITES) {
    const names = [];
    const pattern = new RegExp("^" + source.replace(/[.]/g, "\\.").replace(/:(\w+)/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "$");
    const match = pathname.match(pattern);
    if (match) return names.reduce((dest, name, i) => dest.replace(":" + name, encodeURIComponent(match[i + 1])), destination);
  }
  return pathname;
}

export function startDevServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const target = new URL(rewrite(url.pathname), "http://localhost");
    url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
    if (!target.pathname.startsWith("/api/")) { res.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const type = String(req.headers["content-type"] || "");
    req.body = type.includes("json") ? (body ? JSON.parse(body) : {}) : type.includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(body)) : body;
    req.query = Object.fromEntries(target.searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (value) => { if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); return res; };
    try {
      const mod = await import(pathToFileURL(join(ROOT, target.pathname + ".js")).href);
      await mod.default(req, res);
    } catch (err) {
      if (!res.headersSent) { res.statusCode = err.code === "ERR_MODULE_NOT_FOUND" ? 404 : 500; res.end(); }
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startDevServer(Number(process.argv[2] || 3210));
  console.log(`PAP dev server on http://127.0.0.1:${server.address().port}`);
}
