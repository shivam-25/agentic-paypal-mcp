import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { BRAND_NAME, PAYPAL_LOGIN_PATH, PAYPAL_LOGIN_PORT } from "./config.js";
import { paypalIdentityFromCode, paypalLoginUrl } from "./paypal.js";
import { getOrCreateWallet } from "./wallet.js";

/**
 * Log in with PayPal, for a server that runs on the user's machine.
 *
 * startPaypalLogin() opens a short-lived listener on 127.0.0.1 and returns the
 * PayPal login link. When the user logs in, PayPal sends them back to the
 * listener with a one-time code. We exchange it for their PayPal account id
 * and create (or link) the agent wallet for that account.
 */

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

let listener: Server | null = null;
let timer: NodeJS.Timeout | null = null;
let expectedState = "";
let lastError: string | null = null;

function stopListener() {
  if (timer) clearTimeout(timer);
  timer = null;
  listener?.close();
  listener = null;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${BRAND_NAME}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${body}</p></body>`;
}

/** The error from the most recent login attempt, if it failed. */
export function lastLoginError(): string | null {
  return lastError;
}

/** Start (or restart) a login attempt and return the PayPal link to open. */
export async function startPaypalLogin(): Promise<string> {
  stopListener();
  lastError = null;
  expectedState = randomBytes(16).toString("hex");
  const url = paypalLoginUrl(expectedState);

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname !== PAYPAL_LOGIN_PATH) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    try {
      if (reqUrl.searchParams.get("state") !== expectedState) {
        throw new Error("This login link has expired. Ask your agent for a new one.");
      }
      const code = reqUrl.searchParams.get("code");
      if (!code) throw new Error("PayPal login was cancelled.");
      const identity = await paypalIdentityFromCode(code);
      await getOrCreateWallet(identity);
      res.end(page("PayPal account linked", "You can close this tab and return to your agent."));
    } catch (e: any) {
      lastError = e?.message ?? String(e);
      res.end(page("Could not link PayPal", "Return to your agent and try again."));
    } finally {
      stopListener();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PAYPAL_LOGIN_PORT, "127.0.0.1", () => resolve());
  });
  listener = server;
  timer = setTimeout(stopListener, LOGIN_TIMEOUT_MS);
  timer.unref();
  return url;
}
