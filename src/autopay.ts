import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineChain, getContract, sendTransaction } from "thirdweb";
import { transfer } from "thirdweb/extensions/erc20";
import {
  AGENTPAY_HOME,
  DEFAULT_CHAIN_ID,
  DEFAULT_USD_ASSET,
  TREASURY_ADDRESS,
  thirdwebClient,
} from "./config.js";
import { sendPayout } from "./paypal.js";
import { disburse } from "./treasury.js";
import { loadWalletMeta, serverWalletFor, usdBalance } from "./wallet.js";

/**
 * Automatic payments. The user sets a limit; a purchase at or under it is paid
 * from the pre-funded wallet without asking, and anything larger goes to PayPal
 * for approval. The limit is set by the user in the web interface only. There
 * is deliberately no agent tool that changes it, so an agent cannot raise its
 * own spending limit.
 */

const SETTINGS_FILE = join(AGENTPAY_HOME, "settings.json");
const DEFAULT_LIMIT_USD = 10;
const USD_DECIMALS = 6;

/** The largest purchase, in USD, the agent may pay without asking. 0 turns it off. */
export function autoApproveLimit(): number {
  if (!existsSync(SETTINGS_FILE)) return DEFAULT_LIMIT_USD;
  try {
    const limit = Number(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")).autoApproveLimitUSD);
    return Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_LIMIT_USD;
  } catch {
    return DEFAULT_LIMIT_USD;
  }
}

export function setAutoApproveLimit(limitUSD: number): number {
  const limit = Math.round(limitUSD * 100) / 100;
  writeFileSync(SETTINGS_FILE, JSON.stringify({ autoApproveLimitUSD: limit }, null, 2));
  return limit;
}

export type AutoPayCheck = { ok: true } | { ok: false; reason: string };

/** Whether a purchase of this total can be paid without asking, and if not, why. */
export async function canAutoPay(totalUSD: string): Promise<AutoPayCheck> {
  const total = Number(totalUSD);
  const limit = autoApproveLimit();
  if (limit <= 0) return { ok: false, reason: "automatic payments are turned off." };
  if (total > limit) {
    return { ok: false, reason: `it is above the $${limit.toFixed(2)} automatic limit.` };
  }
  if (!TREASURY_ADDRESS) return { ok: false, reason: "automatic payments are not set up on this server." };
  const meta = loadWalletMeta();
  if (!meta) return { ok: false, reason: "there is no wallet yet." };
  const { usd, baseUnits } = await usdBalance(meta.address);
  if (baseUnits < BigInt(Math.round(total * 10 ** USD_DECIMALS))) {
    return { ok: false, reason: `the wallet balance (${usd}) does not cover it.` };
  }
  return { ok: true };
}

/** Move USD from the agent wallet to the treasury: the reverse of a top-up. */
async function collect(amountUSD: string): Promise<void> {
  const client = thirdwebClient();
  const chain = defineChain(DEFAULT_CHAIN_ID);
  const contract = getContract({ client, chain, address: DEFAULT_USD_ASSET });
  const wallet: any = serverWalletFor(DEFAULT_CHAIN_ID);
  const tx = transfer({ contract, to: TREASURY_ADDRESS, amount: Number(amountUSD) });
  if (typeof wallet.enqueueTransaction === "function") {
    await wallet.enqueueTransaction({ transaction: tx });
  } else {
    await sendTransaction({ account: wallet, transaction: tx });
  }
}

/**
 * Pay a merchant from the pre-funded wallet: take the amount from the wallet,
 * then pay the merchant from this app's PayPal balance. If PayPal refuses the
 * payment, the amount is returned to the wallet.
 */
export async function autoPay(
  merchant: string,
  totalUSD: string,
  note: string,
): Promise<{ payoutId: string }> {
  await collect(totalUSD);
  try {
    const payout = await sendPayout(merchant, totalUSD, note);
    return { payoutId: payout.payoutId };
  } catch (e: any) {
    const refund = await disburse(loadWalletMeta()!.address, totalUSD).catch(() => ({ queued: false }));
    throw new Error(
      `${e?.message ?? String(e)} ${
        refund.queued
          ? "The amount is being returned to the wallet."
          : "The amount could not be returned to the wallet automatically."
      }`,
    );
  }
}
