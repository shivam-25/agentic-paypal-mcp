import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_MERCHANT, PAYPAL_ENVIRONMENT, WEB_UI_PORT } from "./config.js";
import { lastLoginError, startPaypalLogin } from "./login.js";
import { PRODUCTS, STORE_NAME, loadOrders } from "./store.js";
import { loadWalletMeta, usdBalance } from "./wallet.js";

/**
 * The web interface: one page (web/index.html) with the landing page, setup,
 * dashboard and demo store, plus the small JSON API it reads. It is served on
 * 127.0.0.1 only, for the person whose machine the agent runs on.
 */

export const WEB_UI_URL = `http://127.0.0.1:${WEB_UI_PORT}`;

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "index.html");
const ALLOWED_HOSTS = new Set([`127.0.0.1:${WEB_UI_PORT}`, `localhost:${WEB_UI_PORT}`]);

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function status() {
  const meta = loadWalletMeta();
  let balance: string | null = null;
  if (meta) balance = await usdBalance(meta.address).then((b) => b.usd).catch(() => null);
  return {
    sandbox: PAYPAL_ENVIRONMENT !== "PRODUCTION",
    linked: Boolean(meta?.paypalPayerId),
    email: meta?.email ?? null,
    paypalId: meta?.paypalPayerId ?? null,
    wallet: meta?.address ?? null,
    balance,
    loginError: lastLoginError(),
  };
}

/** Start the web interface. Safe to call when the port is taken: it logs and moves on. */
export function startWebUi() {
  const server = createServer(async (req, res) => {
    // Only answer requests addressed to this machine, so no other site can read the API.
    if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) {
      res.writeHead(403).end();
      return;
    }
    const path = new URL(req.url ?? "/", WEB_UI_URL).pathname;
    try {
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(readFileSync(PAGE));
      } else if (req.method === "GET" && path === "/api/status") {
        json(res, 200, await status());
      } else if (req.method === "GET" && path === "/api/orders") {
        json(res, 200, loadOrders());
      } else if (req.method === "GET" && path === "/api/store") {
        json(res, 200, { name: STORE_NAME, merchant: DEMO_MERCHANT || null, products: PRODUCTS });
      } else if (req.method === "POST" && path === "/api/login") {
        // A JSON content type cannot be sent cross-site without permission we never grant.
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
          json(res, 415, { error: "Send JSON." });
        } else {
          json(res, 200, { url: await startPaypalLogin() });
        }
      } else {
        json(res, 404, { error: "Not found." });
      }
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
  });
  server.on("error", (e) => console.error(`Web interface not started: ${e.message}`));
  server.listen(WEB_UI_PORT, "127.0.0.1", () => {
    console.error(`Web interface at ${WEB_UI_URL}`);
  });
}
