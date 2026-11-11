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
import { getOrCreateWallet, loadWalletMeta, usdBalance, gasBalance } from "./wallet.js";
import { payForService } from "./x402.js";
import { createOrder, captureOrder, getOrder } from "./paypal.js";
import { disburse, treasuryConfigured } from "./treasury.js";
import { PRODUCTS, STORE_NAME, productById, recordOrder, markOrderPaid, recordAutoPaidOrder } from "./store.js";
import { autoApproveLimit, dailyAutoLimit, canAutoPay, autoPay } from "./autopay.js";

/**
 * Agentic PayPal — an MCP server that gives the host agent (Claude, Codex, …) a
 * wallet linked to the user's PayPal account, and the ability to buy things:
 *   • goods   — buy from a merchant store; small purchases pay automatically
 *               within the user's limit, larger ones ask for PayPal approval
 *   • services — x402 (pays any HTTP 402 service automatically)
 *   • PayPal  — link an account, fund the wallet, pay/approve an order
 * All amounts are shown in USD.
 */

const server = new McpServer({ name: "agentic-paypal", version: "0.2.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// ── link_paypal / setup_wallet ────────────────────────────────────────────────
// Logging in with PayPal = giving the PayPal email the wallet is linked to. The
// wallet is created for that email and claimable from it.
async function linkWallet(email?: string) {
  const meta = await getOrCreateWallet(email);
  const { usd } = await usdBalance(meta.address).catch(() => ({ usd: "$0.00" }));
  const setupUrl = `${ONBOARD_UI_BASE}?addr=${meta.address}${
    meta.email ? `&email=${encodeURIComponent(meta.email)}` : ""
  }`;
  return text(
    [
      meta.email
        ? `✅ PayPal account ${meta.email} is linked to the agent wallet.`
        : `✅ Agent wallet ready.`,
      `Wallet: ${meta.address}`,
      `Balance: ${usd} USD`,
      ``,
      `Open the setup page to claim it and manage funds:`,
      setupUrl,
      ``,
      usd === "$0.00"
        ? `To add funds, call fund_with_paypal with an amount in USD.`
        : `You can now browse_store and buy_product, or pay_for_service.`,
    ].join("\n"),
  );
}

server.tool(
  "link_paypal",
  "Log in / link the user's PayPal account by email. Call this first. The agent wallet is created for and linked to this PayPal email; purchases and top-ups run through it. Returns the wallet address, USD balance, and a setup link.",
  {
    email: z
      .string()
      .email()
      .describe("The user's PayPal email. The wallet is linked to and claimable by this email."),
  },
  async ({ email }) => linkWallet(email),
);

// Back-compat alias.
server.tool(
  "setup_wallet",
  "Alias of link_paypal: create (or load) the agent's wallet, optionally linked to the user's PayPal email.",
  {
    email: z.string().email().optional().describe("The user's PayPal email."),
  },
  async ({ email }) => linkWallet(email),
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
  "Top up the agent wallet with USD using PayPal. Returns an approval link for the user to complete payment; then call confirm_funding with the orderId.",
  { amountUSD: z.string().describe('Amount in USD, e.g. "5.00".') },
  async ({ amountUSD }) => {
    const meta = await getOrCreateWallet();
    const order = await createOrder(
      Number(amountUSD.replace(/[$,\s]/g, "")).toFixed(2),
      `${BRAND_NAME} top-up for ${meta.address}`,
    );
    return text(
      [
        `💳 PayPal top-up created for ${toUSD(usdToBaseUnits(amountUSD))} USD.`,
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
    const current = await getOrder(orderId);
    if (current.status !== "APPROVED" && current.status !== "COMPLETED") {
      return text(
        `Order ${orderId} is "${current.status}". Ask the user to finish approving it, then try again.`,
      );
    }
    if (current.status === "COMPLETED") return text(`Order ${orderId} already captured. Funds credited.`);
    const cap = await captureOrder(orderId);

    // On-ramp bridge: credit the agent wallet with on-chain USD for the captured amount.
    const meta = loadWalletMeta();
    let creditLine = "";
    if (meta && cap.amountUSD) {
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
  "List the services the agent can buy, with their USD price and URL. Pass a URL from here to pay_for_service to purchase one.",
  {},
  async () => {
    const lines = CATALOGUE.map(
      (i) => `• ${i.title} — ${i.vendor} — ${i.priceUSD}\n  ${i.url}`,
    );
    return text(`Marketplace (${MARKET_BASE}):\n\n${lines.join("\n")}`);
  },
);

// ── browse_store ──────────────────────────────────────────────────────────────
server.tool(
  "browse_store",
  `List the goods for sale in the ${STORE_NAME} store, with their id and USD price. Pass an id to buy_product to purchase one.`,
  {},
  async () => {
    const lines = PRODUCTS.map((p) => `• ${p.id} — ${p.name} — $${p.priceUSD}\n  ${p.description}`);
    const limit = autoApproveLimit();
    const footer = limit > 0
      ? `\n\nPurchases up to $${limit.toFixed(2)} are paid automatically; larger ones ask for PayPal approval.`
      : `\n\nAutomatic payment is off; every purchase asks for PayPal approval.`;
    return text(`${STORE_NAME} store:\n\n${lines.join("\n")}${footer}`);
  },
);

// ── buy_product ───────────────────────────────────────────────────────────────
server.tool(
  "buy_product",
  "Buy a product from the store by id. If the total is within the user's automatic limit it is paid from the wallet right away; otherwise a PayPal approval link is returned and the user must approve, then you call confirm_purchase. Set decidedBy to 'agent' (with a reason) when you chose the purchase yourself for a task the user gave.",
  {
    productId: z.string().describe("A product id from browse_store."),
    qty: z.number().int().positive().optional().describe("Quantity (default 1)."),
    decidedBy: z.enum(["user", "agent"]).optional().describe("Who chose this purchase. Default 'user'."),
    reason: z.string().optional().describe("Why the agent chose this, when decidedBy is 'agent'."),
  },
  async ({ productId, qty, decidedBy, reason }) => {
    const product = productById(productId);
    if (!product) return text(`No product "${productId}". Call browse_store to see what's available.`);
    const meta = loadWalletMeta();
    if (!meta) return text("No wallet yet. Call link_paypal first.");
    const units = qty && qty > 0 ? qty : 1;
    const total = (Number(product.priceUSD) * units).toFixed(2);
    const item = `${units}× ${product.name}`;
    const who = decidedBy ?? "user";

    const check = await canAutoPay(total);
    if (check.ok) {
      await autoPay(total);
      const id = `auto-${Date.now()}`;
      recordAutoPaidOrder({ id, kind: "purchase", item, merchant: DEMO_MERCHANT, amountUSD: total, decidedBy: who, reason });
      return text(
        [
          `✅ Bought ${item} for $${total} — paid automatically from the wallet (within your $${autoApproveLimit().toFixed(2)} limit).`,
          who === "agent" && reason ? `Agent's reason: ${reason}` : ``,
          `Merchant: ${DEMO_MERCHANT}. No approval needed.`,
        ].filter(Boolean).join("\n"),
      );
    }

    // Macro purchase → PayPal approval.
    const order = await createOrder(total, `${BRAND_NAME}: ${item} from ${DEMO_MERCHANT}`);
    recordOrder({ id: order.id, kind: "purchase", item, merchant: DEMO_MERCHANT, amountUSD: total, approveUrl: order.approveUrl, decidedBy: who, reason });
    return text(
      [
        `🧾 ${item} is $${total} — ${check.reason}`,
        `Ask the user to approve the payment in PayPal:`,
        order.approveUrl ?? "(no approval link returned)",
        ``,
        `After they approve, call confirm_purchase with orderId "${order.id}".`,
      ].join("\n"),
    );
  },
);

// ── confirm_purchase ──────────────────────────────────────────────────────────
server.tool(
  "confirm_purchase",
  "Capture a PayPal purchase the user has approved, completing a macro (above-limit) order.",
  { orderId: z.string() },
  async ({ orderId }) => {
    const current = await getOrder(orderId);
    if (current.status !== "APPROVED" && current.status !== "COMPLETED") {
      return text(`Order ${orderId} is "${current.status}". Ask the user to finish approving it, then try again.`);
    }
    if (current.status === "COMPLETED") {
      markOrderPaid(orderId);
      return text(`Order ${orderId} already captured. The purchase is complete.`);
    }
    const cap = await captureOrder(orderId);
    markOrderPaid(orderId);
    return text(`✅ Purchase complete: $${cap.amountUSD} USD paid to the merchant (capture ${cap.captureId}).`);
  },
);

// ── pay_for_service ──────────────────────────────────────────────────────────
server.tool(
  "pay_for_service",
  "Fetch a URL and, if it requires payment (HTTP 402), pay for it automatically from the agent wallet, then return the unlocked content. Works with any x402-compatible service on any chain.",
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
  console.error("Agentic PayPal MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
