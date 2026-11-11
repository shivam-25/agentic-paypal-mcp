# Agentic paypal

**Paypal for Agentic Economy.**

AgenticPaypal is a [Model Context Protocol](https://modelcontextprotocol.io) server. Add it to
**Claude Desktop, Claude Code, or Codex**, onboard with an email, fund it occasionally — and
your agent pays for goods and services on its own, using paypal, across the globe, in **USD**. No payment code, no seed phrases, no
hand-holding.

Built for the **PayPal AI Hackathon**. Two payment rails:

- **PayPal** — fund the agent wallet and pay merchants (Orders API, sandbox).
- **x402** — pay any HTTP `402 Payment Required` service automatically.

Wallets are **thirdweb** server wallets (managed, recoverable, on-ramp-ready). Everything is
presented to the user in dollars; the stablecoin underneath is an implementation detail.

---

## How it works

```
You: "get me the premium oil-market feed"
  → Claude/Codex calls  pay_for_service(url)
  → the service replies HTTP 402 (needs $0.01)
  → AgentPay signs & settles from your wallet  (gasless, in USD)
  → the agent returns the unlocked data
```

Three flows:

1. **Onboard** (once) — Onboard customer using their email associated with paypal. In the background, a thirdweb wallet for your email and
   returns a setup link.
2. **Fund** (occasionally) — `fund_with_paypal($5)` → approve in PayPal → wallet credited.
3. **Pay** (every purchase) — `pay_for_service(url)` pays x402 services; `pay_paypal(...)`
   pays merchants.

## Tools

| Tool | Rail | Description |
|------|------|-------------|
| `setup_wallet` | thirdweb | Create/load the agent wallet from an email; returns address + setup link. |
| `get_balance` | thirdweb | Show the available USD balance. |
| `fund_with_paypal` | PayPal | Create a PayPal order to top up the wallet; returns an approval link. |
| `confirm_funding` | PayPal | Capture the approved payment and credit the wallet in USD. |
| `pay_for_service` | x402 | Call any URL; on HTTP 402, pay automatically and return the content. |
| `pay_paypal` | PayPal | Pay a merchant directly via PayPal in USD. |

## Setup

```bash
npm install
npm run build
cp .env.example .env    # fill in the keys below
```

Required environment variables:

- `THIRDWEB_SECRET_KEY` — from the [thirdweb dashboard](https://thirdweb.com/dashboard).
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` — a
  [PayPal sandbox app](https://developer.paypal.com/dashboard/applications/sandbox).
- `PAYPAL_ENVIRONMENT=SANDBOX`
- *(optional)* `AGENTPAY_TREASURY_ADDRESS` — a thirdweb server wallet holding test USD, used
  to credit agent wallets when a PayPal top-up is captured.

### Add to Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "node",
      "args": ["/absolute/path/to/agentpay-mcp/dist/index.js"],
      "env": {
        "THIRDWEB_SECRET_KEY": "…",
        "PAYPAL_CLIENT_ID": "…",
        "PAYPAL_CLIENT_SECRET": "…",
        "PAYPAL_ENVIRONMENT": "SANDBOX"
      }
    }
  }
}
```

Then ask your agent to `setup_wallet` with your email and you're ready.

## Self-test

Prove the whole chain without an MCP host — creates the wallet and pays a live x402 service:

```bash
node --env-file=.env dist/selftest.js
```

## Status

- ✅ thirdweb server wallet creation
- ✅ x402 payment signed & accepted by the facilitator
- ✅ PayPal sandbox order creation + approval link
- ⬜ funded green run (send test USD to the wallet)

## Testnet only

Runs on **Arbitrum Sepolia** (test USD) and the **PayPal sandbox** (fake money). No real
funds move. Swap to production chains/keys when ready.

## License

MIT — see [LICENSE](./LICENSE).
