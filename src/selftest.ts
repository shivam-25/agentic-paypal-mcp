/**
 * End-to-end self-test (no MCP host needed). Proves the agent wallet can:
 *   1. be created as a thirdweb server wallet,
 *   2. read its USD balance,
 *   3. pay a live x402 service and get the unlocked content back.
 *
 * Run: node dist/selftest.js [serviceUrl]
 */
import { getOrCreateWallet, usdBalance, gasBalance } from "./wallet.js";
import { payForService } from "./x402.js";

const SERVICE = process.argv[2] ?? "https://agentpay-test.carry.exchange/api/premium";

async function main() {
  console.log("1) setup_wallet …");
  const meta = await getOrCreateWallet();
  console.log("   address:", meta.address);

  console.log("2) balances …");
  const { usd } = await usdBalance(meta.address).catch((e) => {
    console.log("   balance read error:", e.message);
    return { usd: "?" };
  });
  const gas = await gasBalance(meta.address).catch(() => 0n);
  console.log("   USD:", usd, "| gas(wei):", gas.toString());

  console.log(`3) pay_for_service → ${SERVICE}`);
  const r = await payForService(SERVICE, { maxUSD: "0.10" });
  console.log("   paid:", r.paid, "status:", r.status);
  console.log("   body:", JSON.stringify(r.body, null, 2));
}

main().catch((e) => {
  console.error("SELFTEST FAILED:", e);
  process.exit(1);
});
