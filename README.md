# Agentic PayPal

**PayPal for the agentic economy.**

Agentic PayPal is a [Model Context Protocol](https://modelcontextprotocol.io) server. Add it to Claude Desktop, Claude Code, or Codex, log in with PayPal once, and your agent can buy goods from merchants for you, in USD, anywhere PayPal works. No payment code, no seed phrases.

Built for the PayPal AI Hackathon.

## How it works

```
You:  "order the blue ceramic mug from Acme Home"
  → the agent calls buy_with_paypal(merchant, item, price)
  → PayPal creates the order and returns an approval link
  → you approve it in PayPal
  → the agent calls confirm_purchase and the merchant is paid
  → you get the PayPal receipt
```

Three flows:

1. **Log in (once)**: `setup_wallet` returns a "Log in with PayPal" link. Logging in links your PayPal account to the agent and creates its wallet.
2. **Buy (every purchase)**: `buy_with_paypal` creates an order with a merchant; you approve it in PayPal; `confirm_purchase` pays the merchant.
3. **Fund (optional)**: `fund_with_paypal` tops up the agent wallet, which pays for small digital services on its own.

## Your PayPal account and the wallet are linked

The wallet belongs to one PayPal account, and the server enforces it:

- You prove which PayPal account is yours by logging in with PayPal. There is no typed email to get wrong or fake.
- The wallet is created for that account's PayPal ID and cannot be re-linked to another account.
- A purchase or top-up is only completed if the PayPal account that approved it is the linked one. Otherwise nothing is charged.
- An order created as a purchase can never be captured as a wallet top-up, or the reverse.

## Tools

| Tool | What it does |
|---|---|
| `setup_wallet` | Log in with PayPal, link the account, create the agent wallet. |
| `buy_with_paypal` | Create an order for goods from a merchant; returns a PayPal approval link. |
| `confirm_purchase` | Pay the merchant once the user has approved the order. |
| `browse_store` | List the goods in the demo store, with prices and the merchant to pay. |
| `get_balance` | Show the wallet's available USD balance. |
| `fund_with_paypal` | Create a PayPal order to top up the wallet; returns an approval link. |
| `confirm_funding` | Capture the approved top-up and credit the wallet in USD. |
| `browse_market` | List digital services the wallet can pay for. |
| `pay_for_service` | Call a URL; on HTTP 402, pay from the wallet and return the content. |

## Automatic payments

Purchases come in two kinds, split by a limit the user sets:

- **At or under the limit**: paid at once from the pre-funded wallet, with no approval step. The merchant is paid from this app's PayPal balance (Payouts API) and the same amount leaves the wallet.
- **Over the limit**: the agent creates a PayPal order and the user approves it in PayPal, as before.

The limit starts at $10. The user changes it on the dashboard, to any amount from $0 (off) up to $100,000. There is deliberately no agent tool that changes the limit, so an agent cannot raise its own spending limit. A purchase the wallet balance cannot cover goes to PayPal for approval.

Automatic payments need `AGENTPAY_TREASURY_ADDRESS` set and Payouts enabled on the PayPal app.

## Web interface

While the server runs, it serves a web interface at `http://127.0.0.1:8766`, on your machine only:

- **Home**: what Agentic PayPal is and how to add it to your agent.
- **Set up**: log in with PayPal from the browser.
- **Dashboard**: the linked PayPal account, wallet balance, purchases waiting for your approval, and purchases paid.
- **Demo store**: a sample shop, Fernhill Goods, for trying the purchase flow.

The page is one file, `web/index.html`, with no dependencies and no build step.

## Two payment rails

- **PayPal** is the main rail: login, merchant purchases, and wallet top-ups (Orders API).
- **x402** is the secondary rail: the wallet pays any `HTTP 402 Payment Required` service automatically, for small digital purchases where an approval step per payment makes no sense.

Wallets are [thirdweb](https://thirdweb.com) server wallets (managed, recoverable). Everything is shown to the user in dollars; the stablecoin underneath is an implementation detail.

## Setup

```bash
npm install
npm run build
cp .env.example .env   # fill in the keys below
```

Environment variables:

- `THIRDWEB_SECRET_KEY`: from the thirdweb dashboard.
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: a PayPal sandbox app.
- `PAYPAL_ENVIRONMENT=SANDBOX`
- *(optional)* `AGENTPAY_LOGIN_PORT`: local port for the PayPal login return. Defaults to `8765`.
- *(optional)* `AGENTPAY_UI_PORT`: local port for the web interface. Defaults to `8766`.
- *(optional)* `AGENTPAY_DEMO_MERCHANT`: the PayPal sandbox business account the demo store pays. The store cannot take orders without it.
- *(optional)* `AGENTPAY_TREASURY_ADDRESS`: a thirdweb server wallet holding test USD, used to credit agent wallets when a PayPal top-up is captured.

### Enable Log in with PayPal

In the PayPal developer dashboard, open the app and:

1. Turn on **Log in with PayPal**, with the **email** attribute.
2. Add `http://127.0.0.1:8765/paypal/callback` as a return URL (change the port if you set `AGENTPAY_LOGIN_PORT`).

### Add to Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentic-paypal": {
      "command": "node",
      "args": ["/absolute/path/to/agentic-paypal/dist/index.js"],
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

Then ask your agent to run `setup_wallet` and log in with PayPal.

## Self-test

Checks the wallet and x402 rail without an MCP host. It creates the wallet and pays a live x402 service:

```bash
node --env-file=.env dist/selftest.js
```

## Status

- ✅ thirdweb server wallet creation
- ✅ x402 payment signed and accepted by the facilitator
- ✅ PayPal sandbox order creation and approval link
- ⬜ Log in with PayPal and account-to-wallet linking (written, not yet run against the sandbox)
- ⬜ Merchant purchases with `buy_with_paypal` (written, not yet run against the sandbox)
- ⬜ Web interface (checked locally with sample data, not yet run with live PayPal data)
- ⬜ Automatic payments within the limit (limit logic tested locally with PayPal stubbed, not yet run against the sandbox)
- ⬜ funded green run (send test USD to the wallet)

Automatic payments are paid by this app's PayPal account, not the buyer's, so PayPal buyer protection does not cover them. Check the rules for holding and paying out customer funds before using this with real money.

## Testnet only

Runs on Arbitrum Sepolia (test USD) and the PayPal sandbox (fake money). No real funds move. Swap to production chains and keys when ready.

## License

MIT. See [LICENSE](LICENSE).
