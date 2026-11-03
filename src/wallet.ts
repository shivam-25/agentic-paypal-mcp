import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Engine, getContract, defineChain } from "thirdweb";
import { balanceOf } from "thirdweb/extensions/erc20";
import { eth_getBalance, getRpcClient } from "thirdweb/rpc";
import {
  WALLET_FILE,
  DEFAULT_CHAIN_ID,
  DEFAULT_USD_ASSET,
  thirdwebClient,
  toUSD,
} from "./config.js";

/**
 * The agent's wallet is a thirdweb **server wallet** (managed, recoverable,
 * and the basis for on-ramp top-ups). It is created once on first use and its
 * address is cached on the host machine. All amounts are reported in USD.
 */

interface WalletMeta {
  address: string;
  label: string;
  email?: string;
  createdAt: string;
}

export function loadWalletMeta(): WalletMeta | null {
  if (!existsSync(WALLET_FILE)) return null;
  try {
    return JSON.parse(readFileSync(WALLET_FILE, "utf8")) as WalletMeta;
  } catch {
    return null;
  }
}

/**
 * Create the agent's thirdweb server wallet if it doesn't exist yet; return its
 * metadata. The wallet is keyed to the user's email (used as the label so it is
 * recoverable/identifiable and claimable from the setup UI).
 */
export async function getOrCreateWallet(email?: string): Promise<WalletMeta> {
  const existing = loadWalletMeta();
  if (existing) {
    if (email && !existing.email) {
      existing.email = email;
      writeFileSync(WALLET_FILE, JSON.stringify(existing, null, 2));
    }
    return existing;
  }

  const client = thirdwebClient();
  const label = email ? `agentpay:${email}` : `agentpay-${Date.now()}`;
  const serverWallet = await Engine.createServerWallet({ client, label });
  const meta: WalletMeta = {
    address: serverWallet.address,
    label,
    email,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(WALLET_FILE, JSON.stringify(meta, null, 2));
  return meta;
}

/** Load the server wallet handle bound to a specific chain (for signing/sending). */
export function serverWalletFor(chainId: number) {
  const meta = loadWalletMeta();
  if (!meta) throw new Error("No wallet yet. Run setup_wallet first.");
  const client = thirdwebClient();
  return Engine.serverWallet({
    client,
    address: meta.address,
    chain: defineChain(chainId),
  });
}

/** USD (stablecoin) balance of the agent wallet on a chain. */
export async function usdBalance(
  address: string,
  chainId = DEFAULT_CHAIN_ID,
  asset = DEFAULT_USD_ASSET,
): Promise<{ usd: string; baseUnits: bigint }> {
  const client = thirdwebClient();
  const contract = getContract({ client, chain: defineChain(chainId), address: asset });
  const baseUnits = await balanceOf({ contract, address });
  return { usd: toUSD(baseUnits), baseUnits };
}

/** Native gas balance (wei) — used internally to warn if the wallet can't transact. */
export async function gasBalance(address: string, chainId = DEFAULT_CHAIN_ID): Promise<bigint> {
  const client = thirdwebClient();
  const rpc = getRpcClient({ client, chain: defineChain(chainId) });
  return eth_getBalance(rpc, { address });
}
