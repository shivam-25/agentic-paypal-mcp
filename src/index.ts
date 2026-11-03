#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_CHAIN_ID, ONBOARD_UI_BASE, toUSD, usdToBaseUnits } from "./config.js";
import { getOrCreateWallet, loadWalletMeta, usdBalance, gasBalance } from "./wallet.js";
import { payForService } from "./x402.js";
import { createOrder, captureOrder, getOrder } from "./paypal.js";
import { disburse, treasuryConfigured } from "./treasury.js";

/**
 * AgentPay — an MCP server that gives the host agent (Claude, Codex, …) a
 * wallet and the ability to pay for services. Two rails:
 *   • crypto  — x402 (pays any HTTP 402 service automatically)
 *   • PayPal  — fund the wallet, or pay a PayPal order
 * All amounts are shown in USD.
 */

const server = new McpServer({ name: "agentpay", version: "0.1.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// ── setup_wallet ────────────────────────────────────────────────────────────
server.tool(
  "setup_wallet",
  "Create (or load) the agent's wallet from the user's email. Call this first. Returns the wallet address, USD balance, and a setup link.",
  {
    email: z
      .string()
      .email()
      .optional()
      .describe("The user's email. The wallet is created for and claimable by this email."),
  },
  async ({ email }) => {
    const meta = await getOrCreateWallet(email);
    const { usd } = await usdBalance(meta.address).catch(() => ({ usd: "$0.00" }));
    const setupUrl = `${ONBOARD_UI_BASE}?addr=${meta.address}${
      meta.email ? `&email=${encodeURIComponent(meta.email)}` : ""
    }`;
    return text(
      [
        `✅ Agent wallet ready${meta.email ? ` for ${meta.email}` : ""}.`,
        `Address: ${meta.address}`,
        `Balance: ${usd} USD`,
        ``,
        `Open the setup page to claim it and manage funds:`,
        setupUrl,
        ``,
        usd === "$0.00"
          ? `To add funds, call fund_with_paypal with an amount in USD (PayPal is the default).`
          : `You can now pay for services with pay_for_service.`,
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
  "Top up the agent wallet with USD using PayPal. Returns an approval link for the user to complete payment; then call confirm_funding with the orderId.",
  { amountUSD: z.string().describe('Amount in USD, e.g. "5.00".') },
  async ({ amountUSD }) => {
    const meta = await getOrCreateWallet();
    const order = await createOrder(
      Number(amountUSD.replace(/[$,\s]/g, "")).toFixed(2),
      `AgentPay top-up for ${meta.address}`,
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

// ── pay_paypal ───────────────────────────────────────────────────────────────
server.tool(
  "pay_paypal",
  "Pay a merchant directly via PayPal in USD (fiat rail). Returns an approval link to complete the payment.",
  {
    amountUSD: z.string(),
    description: z.string().describe("What the payment is for."),
  },
  async ({ amountUSD, description }) => {
    const order = await createOrder(
      Number(amountUSD.replace(/[$,\s]/g, "")).toFixed(2),
      description,
    );
    return text(
      [
        `💳 PayPal payment created: ${toUSD(usdToBaseUnits(amountUSD))} USD for "${description}".`,
        `Order: ${order.id}`,
        `Approve here: ${order.approveUrl ?? "(no link)"}`,
        `Then call confirm_funding with orderId "${order.id}" to capture it.`,
      ].join("\n"),
    );
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AgentPay MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
