#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BRAND_NAME,
  DEFAULT_CHAIN_ID,
  DEMO_MERCHANT,
  ONBOARD_UI_BASE,
  toUSD,
  usdToBaseUnits,
} from "./config.js";
import { loadWalletMeta, usdBalance, gasBalance, type WalletMeta } from "./wallet.js";
import { payForService } from "./x402.js";
import { createOrder, captureOrder, getOrder } from "./paypal.js";
import { disburse, treasuryConfigured } from "./treasury.js";
import { lastLoginError, startPaypalLogin } from "./login.js";
import { PRODUCTS, STORE_NAME, markOrderPaid, recordAutoPaidOrder, recordOrder } from "./store.js";
import { autoApproveLimit, autoPay, canAutoPay } from "./autopay.js";
import { TOOLS } from "./registry.js";
import { WEB_UI_URL, startWebUi } from "./web.js";

/**
 * Agentic PayPal — an MCP server that lets the host agent (Claude, Codex, …)
 * buy goods for the user with PayPal.
 *   • PayPal — log in, buy goods from merchants, top up the agent wallet
 *   • x402   — pay HTTP 402 digital services from the agent wallet
 * The wallet is linked to the user's PayPal account. All amounts are in USD.
 */

const server = new McpServer({ name: "agentic-paypal", version: "0.1.0" });

// Keep every tool's handler by name as it is registered, so the chat console
// in the web interface can run the same tools.
const registerTool = server.tool.bind(server) as (...args: any[]) => unknown;
(server as any).tool = (name: string, ...rest: any[]) => {
  TOOLS.set(name, rest[rest.length - 1]);
  return registerTool(name, ...rest);
};

// Tags stored on PayPal orders so a purchase can never be captured as a top-up.
const PURCHASE_TAG = "purchase";
const topUpTag = (address: string) => `topup:${address}`;

const NOT_LINKED = "No PayPal account linked yet. Call setup_wallet first.";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** The wallet, only if it has been linked to a PayPal account. */
function linkedWallet(): (WalletMeta & { paypalPayerId: string }) | null {
  const meta = loadWalletMeta();
  return meta?.paypalPayerId ? (meta as WalletMeta & { paypalPayerId: string }) : null;
}

/** Normalise "$1,234.5" → "1234.50". Returns null if it isn't a positive amount. */
function cleanUSD(amount: string): string | null {
  const n = Number(amount.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

// ── setup_wallet ────────────────────────────────────────────────────────────
server.tool(
  "setup_wallet",
  "Link the user's PayPal account and create the agent's wallet. Call this first. Returns a PayPal login link; after the user logs in, call it again to confirm.",
  {},
  async () => {
    const meta = linkedWallet();
    if (meta) {
      const { usd } = await usdBalance(meta.address).catch(() => ({ usd: "$0.00" }));
      const setupUrl = `${ONBOARD_UI_BASE}?addr=${meta.address}`;
      return text(
        [
          `✅ ${BRAND_NAME} is ready${meta.email ? ` for ${meta.email}` : ""}.`,
          `Linked PayPal account: ${meta.paypalPayerId}`,
          `Wallet: ${meta.address}`,
          `Balance: ${usd} USD`,
          ``,
          `Dashboard: ${WEB_UI_URL}/#/dashboard`,
          `Manage funds: ${setupUrl}`,
          ``,
          `You can now buy goods with buy_with_paypal.`,
        ].join("\n"),
      );
    }
    try {
      const failed = lastLoginError();
      const url = await startPaypalLogin();
      return text(
        [
          failed ? `The last login attempt failed: ${failed}\n` : ``,
          `Ask the user to log in with PayPal here (link valid for 10 minutes):`,
          url,
          ``,
          `After they log in, call setup_wallet again to confirm the account is linked.`,
        ]
          .filter((l, i) => i > 0 || l)
          .join("\n"),
      );
    } catch (e: any) {
      return text(`Could not start PayPal login: ${e?.message ?? String(e)}`);
    }
  },
);

// ── buy_with_paypal ──────────────────────────────────────────────────────────
server.tool(
  "buy_with_paypal",
  "Buy goods from a merchant. A purchase within the user's automatic limit is paid at once from the wallet. A larger one returns a PayPal approval link for the user; then call confirm_purchase with the orderId.",
  {
    merchant: z
      .string()
      .describe("The merchant's PayPal email address or PayPal merchant ID."),
    item: z.string().describe("What is being bought, as it should appear on the PayPal receipt."),
    priceUSD: z.string().describe('Price per item in USD, e.g. "24.99".'),
    quantity: z.number().int().min(1).max(99).optional().describe("How many. Defaults to 1."),
  },
  async ({ merchant, item, priceUSD, quantity }) => {
    if (!linkedWallet()) return text(NOT_LINKED);
    const unit = cleanUSD(priceUSD);
    if (!unit) return text(`"${priceUSD}" is not a valid USD price.`);
    const qty = quantity ?? 1;
    const total = (Number(unit) * qty).toFixed(2);
    const auto = await canAutoPay(total).catch((e: any) => ({
      ok: false as const,
      reason: `the wallet could not be checked (${e?.message ?? String(e)}).`,
    }));
    if (auto.ok) {
      try {
        const paid = await autoPay(merchant, total, `${qty} × ${item}`);
        recordAutoPaidOrder({
          id: paid.payoutId,
          kind: "purchase",
          item: `${qty} × ${item}`,
          merchant,
          amountUSD: total,
        });
        return text(
          [
            `✅ Paid automatically: ${qty} × ${item} from ${merchant} — $${total} USD from the wallet.`,
            `It was within the user's $${autoApproveLimit().toFixed(2)} automatic limit, so no approval was needed.`,
            `PayPal payout ${paid.payoutId}.`,
          ].join("\n"),
        );
      } catch (e: any) {
        return text(`Automatic payment failed: ${e?.message ?? String(e)}`);
      }
    }
    try {
      const order = await createOrder(total, `${item} ×${qty}`, {
        payee: merchant.includes("@") ? { email: merchant } : { merchantId: merchant },
        item: { name: item, quantity: qty, unitAmountUSD: unit },
        customId: PURCHASE_TAG,
      });
      recordOrder({
        id: order.id,
        kind: "purchase",
        item: `${qty} × ${item}`,
        merchant,
        amountUSD: total,
        approveUrl: order.approveUrl,
      });
      return text(
        [
          `🛒 Order created: ${qty} × ${item} from ${merchant} — $${total} USD.`,
          `Order: ${order.id} (status: ${order.status})`,
          ``,
          `It needs the user's approval because ${auto.reason}`,
          `Ask the user to approve the purchase here:`,
          order.approveUrl ?? "(no approval link returned)",
          ``,
          `After they approve, call confirm_purchase with orderId "${order.id}".`,
        ].join("\n"),
      );
    } catch (e: any) {
      return text(`Could not create the order: ${e?.message ?? String(e)}`);
    }
  },
);

// ── confirm_purchase ─────────────────────────────────────────────────────────
server.tool(
  "confirm_purchase",
  "Complete a purchase the user has approved in PayPal, paying the merchant. Returns the receipt.",
  { orderId: z.string() },
  async ({ orderId }) => {
    const meta = linkedWallet();
    if (!meta) return text(NOT_LINKED);
    try {
      const current = await getOrder(orderId);
      if (current.customId !== PURCHASE_TAG) {
        return text(`Order ${orderId} is not a purchase created by buy_with_paypal.`);
      }
      if (current.status === "COMPLETED") return text(`Order ${orderId} is already paid.`);
      if (current.status !== "APPROVED") {
        return text(
          `Order ${orderId} is "${current.status}". Ask the user to finish approving it, then try again.`,
        );
      }
      if (current.payerId !== meta.paypalPayerId) {
        return text(
          `Order ${orderId} was approved by a different PayPal account than the one linked to this wallet. Not paid.`,
        );
      }
      const cap = await captureOrder(orderId);
      markOrderPaid(orderId);
      return text(
        `✅ Paid: $${cap.amountUSD} USD to the merchant (PayPal capture ${cap.captureId}).`,
      );
    } catch (e: any) {
      return text(`Purchase failed: ${e?.message ?? String(e)}`);
    }
  },
);

// ── browse_store ──
server.tool(
  "browse_store",
  "List the goods in the demo store, with prices and the merchant to pay. Pass a product's name, price and the merchant to buy_with_paypal to buy it.",
  {},
  async () => {
    if (!DEMO_MERCHANT) {
      return text(
        "The demo store has no merchant yet. Set AGENTPAY_DEMO_MERCHANT to a PayPal sandbox business account.",
      );
    }
    const lines = PRODUCTS.map((p) => `• ${p.name} — $${p.priceUSD} — ${p.description}`);
    return text(
      [
        `${STORE_NAME} (merchant: ${DEMO_MERCHANT})`,
        ``,
        ...lines,
        ``,
        `See the store: ${WEB_UI_URL}/#/store`,
      ].join("\n"),
    );
  },
);

// ── get_balance ──────────────────────────────────────────────────────────────
server.tool(
  "get_balance",
  "Show the agent wallet's available USD balance.",
  { chainId: z.number().optional().describe("Optional chain id; defaults to the configured chain.") },
  async ({ chainId }) => {
    const meta = loadWalletMeta();
    if (!meta) return text("No wallet yet. Call setup_wallet first.");
    const { usd } = await usdBalance(meta.address, chainId ?? DEFAULT_CHAIN_ID);
    const gas = await gasBalance(meta.address, chainId ?? DEFAULT_CHAIN_ID).catch(() => 0n);
    const warn = gas === 0n ? "\n⚠️ Wallet has no gas; some payments may need a top-up." : "";
    return text(`Available: ${usd} USD\nAddress: ${meta.address}${warn}`);
  },
);

// ── fund_with_paypal ─────────────────────────────────────────────────────────
server.tool(
  "fund_with_paypal",
  "Top up the agent wallet with USD from the linked PayPal account. Returns an approval link for the user to complete payment; then call confirm_funding with the orderId.",
  { amountUSD: z.string().describe('Amount in USD, e.g. "5.00".') },
  async ({ amountUSD }) => {
    const meta = linkedWallet();
    if (!meta) return text(NOT_LINKED);
    const amount = cleanUSD(amountUSD);
    if (!amount) return text(`"${amountUSD}" is not a valid USD amount.`);
    const order = await createOrder(amount, `${BRAND_NAME} top-up for ${meta.address}`, {
      customId: topUpTag(meta.address),
    });
    recordOrder({
      id: order.id,
      kind: "topup",
      item: "Wallet top-up",
      amountUSD: amount,
      approveUrl: order.approveUrl,
    });
    return text(
      [
        `💳 PayPal top-up created for ${toUSD(usdToBaseUnits(amount))} USD.`,
        `Order: ${order.id} (status: ${order.status})`,
        ``,
        `Ask the user to approve the payment here:`,
        order.approveUrl ?? "(no approval link returned)",
        ``,
        `After they approve, call confirm_funding with orderId "${order.id}".`,
      ].join("\n"),
    );
  },
);

// ── confirm_funding ──────────────────────────────────────────────────────────
server.tool(
  "confirm_funding",
  "Capture a PayPal top-up the user has approved, crediting the agent wallet in USD.",
  { orderId: z.string() },
  async ({ orderId }) => {
    const meta = linkedWallet();
    if (!meta) return text(NOT_LINKED);
    const current = await getOrder(orderId);
    if (current.customId !== topUpTag(meta.address)) {
      return text(`Order ${orderId} is not a top-up for this wallet.`);
    }
    if (current.status !== "APPROVED" && current.status !== "COMPLETED") {
      return text(
        `Order ${orderId} is "${current.status}". Ask the user to finish approving it, then try again.`,
      );
    }
    if (current.status === "COMPLETED") return text(`Order ${orderId} already captured. Funds credited.`);
    if (current.payerId !== meta.paypalPayerId) {
      return text(
        `Order ${orderId} was approved by a different PayPal account than the one linked to this wallet. Not captured.`,
      );
    }
    const cap = await captureOrder(orderId);
    markOrderPaid(orderId);

    // On-ramp bridge: credit the agent wallet with on-chain USD for the captured amount.
    let creditLine = "";
    if (cap.amountUSD) {
      if (treasuryConfigured()) {
        try {
          const d = await disburse(meta.address, cap.amountUSD);
          creditLine = d.queued
            ? `On-chain credit queued (ref ${d.txId ?? "pending"}).`
            : `On-chain credit pending treasury setup.`;
        } catch (e: any) {
          creditLine = `PayPal captured, but on-chain credit failed: ${e?.message ?? e}`;
        }
      } else {
        creditLine = `PayPal captured. (Treasury not configured — set AGENTPAY_TREASURY_ADDRESS to auto-credit on-chain.)`;
      }
    }
    return text(
      [
        `✅ PayPal payment captured: $${cap.amountUSD} USD (capture ${cap.captureId}).`,
        creditLine,
        `The agent wallet is being funded and will be able to pay for services.`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },
);

// ── browse_market ─────────────────────────────────────────────────────────────
const MARKET_BASE = process.env.AGENTPAY_MARKET_BASE ?? "https://agentpay-test.carry.exchange";
const CATALOGUE = [
  {
    id: "brent",
    title: "Live BRENT market snapshot",
    vendor: "Carry Exchange",
    priceUSD: "$0.001",
    url: `${MARKET_BASE}/api/premium`,
  },
  {
    id: "signal",
    title: "Commodity momentum signal",
    vendor: "Carry Quant",
    priceUSD: "$0.001",
    url: `${MARKET_BASE}/api/signal`,
  },
  {
    id: "book",
    title: '"Agentic Payments" — Chapter 1',
    vendor: "Agentic PayPal Press",
    priceUSD: "$0.001",
    url: `${MARKET_BASE}/api/book`,
  },
];

server.tool(
  "browse_market",
  "List the digital services the agent can buy from its wallet balance, with their USD price and URL. Pass a URL from here to pay_for_service. For physical goods from a merchant, use buy_with_paypal instead.",
  {},
  async () => {
    const lines = CATALOGUE.map(
      (i) => `• ${i.title} — ${i.vendor} — ${i.priceUSD}\n  ${i.url}`,
    );
    return text(`Marketplace (${MARKET_BASE}):\n\n${lines.join("\n")}`);
  },
);

// ── pay_for_service ──────────────────────────────────────────────────────────
server.tool(
  "pay_for_service",
  "Fetch a URL and, if it requires payment (HTTP 402), pay for it automatically from the agent wallet, then return the unlocked content. For digital services; works with any x402-compatible service on any chain.",
  {
    url: z.string().describe("The service URL to call."),
    maxUSD: z.string().optional().describe('Spending cap for this call, e.g. "0.10".'),
    chainId: z.number().optional(),
  },
  async ({ url, maxUSD, chainId }) => {
    const meta = loadWalletMeta();
    if (!meta) return text("No wallet yet. Call setup_wallet first.");
    try {
      const r = await payForService(url, { maxUSD, chainId });
      if (r.paid) {
        return text(`✅ Paid and unlocked:\n\n${JSON.stringify(r.body, null, 2)}`);
      }
      return text(
        `Could not complete payment (status ${r.status}). ` +
          `The wallet may need more funds — call get_balance or fund_with_paypal.\n\n` +
          JSON.stringify(r.body, null, 2),
      );
    } catch (e: any) {
      return text(`Payment failed: ${e?.message ?? String(e)}`);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  startWebUi();
  console.error("Agentic PayPal MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
