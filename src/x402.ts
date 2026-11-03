import { wrapFetchWithPayment } from "thirdweb/x402";
import { defineChain } from "thirdweb";
import { thirdwebClient, usdToBaseUnits } from "./config.js";
import { serverWalletFor } from "./wallet.js";

/**
 * The crypto pay rail. `payForService` fetches any URL; if the service answers
 * HTTP 402 (x402), it pays automatically from the agent's server wallet and
 * returns the unlocked content. Chain-agnostic: it settles on whatever chain
 * the service's 402 challenge specifies.
 */

export interface PayResult {
  paid: boolean;
  status: number;
  body: unknown;
}

/**
 * Adapt the thirdweb server wallet into the minimal Wallet interface that
 * wrapFetchWithPayment expects (getAccount / getChain / switchChain).
 */
function walletAdapter(chainId: number) {
  const sw: any = serverWalletFor(chainId);
  const account = typeof sw.getAccount === "function" ? sw.getAccount() : sw;
  let chain = defineChain(chainId);
  return {
    getAccount: () => account,
    getChain: () => chain,
    switchChain: async (c: any) => {
      chain = c;
    },
  } as any;
}

export async function payForService(
  url: string,
  opts: { maxUSD?: string; chainId?: number; method?: string; init?: RequestInit } = {},
): Promise<PayResult> {
  const chainId = opts.chainId ?? 421614;
  const client = thirdwebClient();
  const wallet = walletAdapter(chainId);
  const maxValue = opts.maxUSD ? usdToBaseUnits(opts.maxUSD) : undefined;

  const fetchWithPay = wrapFetchWithPayment(fetch, client, wallet, maxValue);
  const res = await fetchWithPay(url, opts.init ?? { method: opts.method ?? "GET" });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  return { paid: res.status === 200, status: res.status, body };
}
