# Agentic PayPal

**PayPal for the agentic economy** — give any AI agent a wallet linked to the user's PayPal
account, and let it buy things.

Agentic PayPal is a [Model Context Protocol](https://modelcontextprotocol.io) server. Add it to
**Claude Desktop, Claude Code, or Codex**, log in with your PayPal email, and your agent can buy
**goods** from a merchant store and **services** on its own, in **USD** — no payment code, no seed
phrases.

Built for the **PayPal AI Hackathon**. PayPal is a merchant business, so the demo leads with
**buying goods**, with small-dollar and large-dollar payments handled differently:

- **Micro (pre-approved)** — purchases within the user's limit are paid automatically from the
  pre-funded wallet, no prompt.
- **Macro (post-approval)** — larger purchases return a PayPal approval link; the user approves,
  then the agent captures it.

Both the **agent** (for a goal you give it) and the **user** can buy; every order records who chose
it. Wallets are **thirdweb** server wallets (managed, recoverable, on-ramp-ready). Amounts are shown
in dollars; the stablecoin underneath is an implementation detail.

---

## How it works

```
You: "buy me a mug and a notebook set"
  → agent calls  browse_store()  then  buy_product("mug")  buy_product("notebooks")
  → each is within your $10 auto-limit → paid from the wallet instantly
You: "order the $39 desk lamp"
  → buy_product("lamp") is above the limit → returns a PayPal approval link
  → you approve → agent calls confirm_purchase(orderId) → done
```

Flows:

1. **Log in** (once) — `link_paypal(email)` links the wallet to the user's PayPal email.
2. **Fund** (occasionally) — `fund_with_paypal($20)` → approve in PayPal → wallet credited.
3. **Buy** — `buy_product(id)` for goods (auto or approval by amount); `pay_for_service(url)` for
   x402 data services.

## Tools

| Tool | Description |
|------|-------------|
| `link_paypal` | Log in / link the wallet to the user's PayPal email. Call first. (`setup_wallet` is an alias.) |
| `get_balance` | Show the available USD balance. |
| `fund_with_paypal` | Create a PayPal order to top up the wallet; returns an approval link. |
| `confirm_funding` | Capture an approved top-up and credit the wallet in USD. |
| `browse_store` | List the merchant store's goods, with id, price, and the auto-pay limit. |
| `buy_product` | Buy a good. Within the limit → paid automatically; above it → PayPal approval link. Records `decidedBy` user/agent + reason. |
| `confirm_purchase` | Capture an approved (macro) purchase. |
| `browse_market` | List x402 data services the agent can buy. |
| `pay_for_service` | Call any URL; on HTTP 402, pay automatically and return the content. |

### Spending limits

The user sets two limits (not changeable by any agent tool, so an agent can't raise its own cap):

- `AGENTPAY_AUTO_LIMIT_USD` — largest single auto-paid purchase (default `10`).
- `AGENTPAY_DAILY_LIMIT_USD` — most auto-paid in one day (default `50`).

Both are also stored per-user in `~/.agentpay/settings.json`.

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
- *(optional)* `AGENTPAY_TREASURY_ADDRESS` — a thirdweb server wallet holding test USD, used to
  credit agent wallets on a top-up and to collect auto-paid purchases.

### Add to Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentic-paypal": {
      "command": "node",
      "args": ["/absolute/path/to/agentic-paypal-mcp/dist/index.js"],
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

Then ask your agent to `link_paypal` with your PayPal email and you're ready.

## Testnet only

Runs on **Arbitrum Sepolia** (test USD) and the **PayPal sandbox** (fake money). No real funds
move. Swap to production chains/keys when ready.

## License

MIT — see [LICENSE](./LICENSE).
