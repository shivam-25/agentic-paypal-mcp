import { Engine, getContract, defineChain, sendTransaction } from "thirdweb";
import { transfer } from "thirdweb/extensions/erc20";
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_USD_ASSET,
  TREASURY_ADDRESS,
  thirdwebClient,
} from "./config.js";

/**
 * Treasury = the on-ramp bridge. When a PayPal top-up is captured (fiat), the
 * treasury server wallet disburses the same amount of on-chain USD to the
 * agent wallet. This is what turns a PayPal payment into spendable agent funds.
 *
 * The treasury is a thirdweb server wallet funded once with testnet USD.
 */

export function treasuryConfigured(): boolean {
  return Boolean(TREASURY_ADDRESS);
}

/** Send `amountUSD` of on-chain USD from the treasury to the agent wallet. */
export async function disburse(
  toAddress: string,
  amountUSD: string,
  chainId = DEFAULT_CHAIN_ID,
  asset = DEFAULT_USD_ASSET,
): Promise<{ queued: boolean; txId?: string }> {
  if (!TREASURY_ADDRESS) {
    return { queued: false };
  }
  const client = thirdwebClient();
  const chain = defineChain(chainId);
  const contract = getContract({ client, chain, address: asset });

  const treasury: any = Engine.serverWallet({
    client,
    address: TREASURY_ADDRESS,
    chain,
  });

  const tx = transfer({
    contract,
    to: toAddress,
    amount: Number(amountUSD.replace(/[$,\s]/g, "")),
  });

  // Engine server wallets enqueue transactions; fall back to sendTransaction.
  if (typeof treasury.enqueueTransaction === "function") {
    const r = await treasury.enqueueTransaction({ transaction: tx });
    return { queued: true, txId: r?.transactionId ?? r?.id };
  }
  const r = await sendTransaction({ account: treasury, transaction: tx });
  return { queued: true, txId: (r as any)?.transactionHash };
}
