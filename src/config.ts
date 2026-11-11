import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createThirdwebClient, type ThirdwebClient } from "thirdweb";

/**
 * Central configuration. Everything the agent needs is read from the
 * environment so the same server can run against sandbox or production and
 * against any chain. Money is presented to the user in USD; the underlying
 * stablecoin is an implementation detail and never surfaced by name.
 */

// Product name shown to the user (PayPal checkout, login page, tool output).
export const BRAND_NAME = "Agentic PayPal";

export const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID ?? "";
export const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ?? "";
export const PAYPAL_ENVIRONMENT = (process.env.PAYPAL_ENVIRONMENT ?? "SANDBOX").toUpperCase();
export const PAYPAL_API_BASE =
  process.env.PAYPAL_API_BASE ??
  (PAYPAL_ENVIRONMENT === "PRODUCTION"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com");

// PayPal's browser-facing host, used for the "Log in with PayPal" page.
export const PAYPAL_WEB_BASE =
  process.env.PAYPAL_WEB_BASE ??
  (PAYPAL_ENVIRONMENT === "PRODUCTION"
    ? "https://www.paypal.com"
    : "https://www.sandbox.paypal.com");

// "Log in with PayPal" returns the user to a short-lived listener on this
// machine. The redirect URL must be registered as a return URL on the PayPal app.
export const PAYPAL_LOGIN_PORT = Number(process.env.AGENTPAY_LOGIN_PORT ?? 8765);
export const PAYPAL_LOGIN_PATH = "/paypal/callback";
export const PAYPAL_LOGIN_REDIRECT =
  process.env.AGENTPAY_LOGIN_REDIRECT ??
  `http://127.0.0.1:${PAYPAL_LOGIN_PORT}${PAYPAL_LOGIN_PATH}`;

export const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY ?? "";

// Default settlement chain for the crypto rail. The pay tool is chain-agnostic:
// it settles on whatever chain a 402-gated service asks for. This is only the
// default used for balance display and PayPal-funded top-ups.
export const DEFAULT_CHAIN_ID = Number(process.env.AGENTPAY_CHAIN_ID ?? 421614);

// The USD stablecoin contract on the default chain (never shown to the user).
export const DEFAULT_USD_ASSET =
  process.env.AGENTPAY_USDC ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

// Treasury server wallet that holds USD and disburses it to agent wallets when a
// PayPal top-up is captured (the on-ramp bridge: PayPal fiat → on-chain USD).
export const TREASURY_ADDRESS = process.env.AGENTPAY_TREASURY_ADDRESS ?? "";

// Hosted onboarding / funding UI base.
export const ONBOARD_UI_BASE =
  process.env.AGENTPAY_ONBOARD_URL ?? "https://agentpay-test.carry.exchange/onboard";

// Where the agent's wallet metadata lives on the host machine.
export const AGENTPAY_HOME = process.env.AGENTPAY_HOME ?? join(homedir(), ".agentpay");
mkdirSync(AGENTPAY_HOME, { recursive: true });
export const WALLET_FILE = join(AGENTPAY_HOME, "wallet.json");

let _client: ThirdwebClient | null = null;
export function thirdwebClient(): ThirdwebClient {
  if (!THIRDWEB_SECRET_KEY) {
    throw new Error(
      "THIRDWEB_SECRET_KEY is not set. Add it to the MCP server env (see README).",
    );
  }
  if (!_client) _client = createThirdwebClient({ secretKey: THIRDWEB_SECRET_KEY });
  return _client;
}

export function assertPaypalConfigured() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error(
      "PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (see README).",
    );
  }
}

/** Format an internal 6-decimal stablecoin amount as a USD string. */
export function toUSD(baseUnits: bigint, decimals = 6): string {
  const neg = baseUnits < 0n;
  const v = neg ? -baseUnits : baseUnits;
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals))
    .toString()
    .padStart(decimals, "0")
    .slice(0, 2);
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${frac}`;
}

/** Parse a USD string/number (e.g. "0.01", 1.5) into 6-decimal base units. */
export function usdToBaseUnits(usd: string | number, decimals = 6): bigint {
  const s = String(usd).replace(/[$,\s]/g, "");
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}
