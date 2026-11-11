import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine, getContract, defineChain, sendTransaction } from "thirdweb";
import { transfer } from "thirdweb/extensions/erc20";
import {
  AGENTPAY_HOME,
  DEFAULT_CHAIN_ID,
  DEFAULT_USD_ASSET,
  TREASURY_ADDRESS,
  thirdwebClient,
} from "./config.js";
import { autoSpentToday } from "./store.js";
import { disburse } from "./treasury.js";
import { loadWalletMeta, serverWalletFor, usdBalance } from "./wallet.js";

/**
 * Automatic payments. The user sets two limits: the largest single purchase and
 * the most in one day. A purchase inside both is paid from the pre-funded wallet
 * without asking (micro / pre-approved), whether the user asked for it or the
 * agent chose it. Anything beyond goes to PayPal for approval (macro / post-
 * approval). The limits live in settings.json, set by the user — there is
 * deliberately no agent tool that changes them, so an agent cannot raise its
 * own spending limit.
 */

const SETTINGS_FILE = join(AGENTPAY_HOME, "settings.json");
const DEFAULT_LIMIT_USD = Number(process.env.AGENTPAY_AUTO_LIMIT_USD ?? 10);
const DEFAULT_DAILY_USD = Number(process.env.AGENTPAY_DAILY_LIMIT_USD ?? 50);
const USD_DECIMALS = 6;

function readSetting(key: string, fallback: number): number {
  if (!existsSync(SETTINGS_FILE)) return fallback;
  try {
    const value = Number(JSON.parse(readFileSync(SETTINGS_FILE, "utf8"))[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

/** The largest single purchase, in USD, the agent may pay without asking. 0 turns it off. */
export function autoApproveLimit(): number {
  return readSetting("autoApproveLimitUSD", DEFAULT_LIMIT_USD);
}

/** The most, in USD, the agent may pay without asking in one day. 0 turns it off. */
export function dailyAutoLimit(): number {
  return readSetting("dailyLimitUSD", DEFAULT_DAILY_USD);
}

export function setAutoLimits(perPurchaseUSD: number, perDayUSD: number) {
  const round = (n: number) => Math.round(n * 100) / 100;
  const settings = { autoApproveLimitUSD: round(perPurchaseUSD), dailyLimitUSD: round(perDayUSD) };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return { autoLimit: settings.autoApproveLimitUSD, dailyLimit: settings.dailyLimitUSD };
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
  const daily = dailyAutoLimit();
  const spent = autoSpentToday();
  if (daily > 0 && spent + total > daily) {
    return {
      ok: false,
      reason: `it would pass the $${daily.toFixed(2)} a day automatic limit ($${spent.toFixed(
        2,
      )} already paid today).`,
    };
  }
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
  if (!TREASURY_ADDRESS) return; // demo: no treasury to collect into; the log still records the sale.
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
 * Pay for a purchase automatically from the pre-funded wallet: take the amount
 * from the agent wallet into the treasury (the merchant is settled off this
 * balance). If the transfer fails, nothing is deducted.
 */
export async function autoPay(totalUSD: string): Promise<void> {
  try {
    await collect(totalUSD);
  } catch (e: any) {
    // Best-effort refund is a no-op here (nothing left the wallet on failure).
    await disburse(loadWalletMeta()!.address, "0").catch(() => {});
    throw new Error(e?.message ?? String(e));
  }
}
