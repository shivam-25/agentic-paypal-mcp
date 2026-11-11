import {
  BRAND_NAME,
  PAYPAL_API_BASE,
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_LOGIN_REDIRECT,
  PAYPAL_WEB_BASE,
  assertPaypalConfigured,
} from "./config.js";

/**
 * Thin PayPal REST client for the fiat rail:
 *  • Orders API v2 — buy goods from a merchant, or top up the agent's balance.
 *  • Log in with PayPal — prove which PayPal account owns the agent wallet.
 * Runs against the sandbox by default.
 */

let _token: { value: string; exp: number } | null = null;

function basicAuth(): string {
  return Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
}

export async function paypalAccessToken(): Promise<string> {
  assertPaypalConfigured();
  if (_token && Date.now() < _token.exp - 60_000) return _token.value;
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const json: any = await res.json();
  _token = { value: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return _token.value;
}

// ── Log in with PayPal ───────────────────────────────────────────────────────

export interface PaypalIdentity {
  /** PayPal's stable account id. This is what the agent wallet is linked to. */
  payerId: string;
  email?: string;
}

/** The PayPal page where the user logs in and consents to share their identity. */
export function paypalLoginUrl(state: string): string {
  assertPaypalConfigured();
  const q = new URLSearchParams({
    flowEntry: "static",
    client_id: PAYPAL_CLIENT_ID,
    response_type: "code",
    scope: "openid email",
    redirect_uri: PAYPAL_LOGIN_REDIRECT,
    state,
  });
  return `${PAYPAL_WEB_BASE}/signin/authorize?${q.toString()}`;
}

/** Exchange the code PayPal sent back after login for the user's identity. */
export async function paypalIdentityFromCode(code: string): Promise<PaypalIdentity> {
  assertPaypalConfigured();
  const tokenRes = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(`PayPal login failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const token: any = await tokenRes.json();

  const infoRes = await fetch(`${PAYPAL_API_BASE}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const info: any = await infoRes.json();
  if (!infoRes.ok) {
    throw new Error(`PayPal identity lookup failed: ${infoRes.status} ${JSON.stringify(info)}`);
  }
  const payerId: string | undefined = info.payer_id;
  if (!payerId) throw new Error("PayPal did not return an account id for this login.");
  const emails: any[] = Array.isArray(info.emails) ? info.emails : [];
  const email: string | undefined = (emails.find((e) => e.primary) ?? emails[0])?.value;
  return { payerId, email };
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface PaypalOrder {
  id: string;
  status: string;
  approveUrl?: string;
}

export interface OrderOptions {
  /** Merchant to pay. Omit to pay this app's own PayPal account (top-ups). */
  payee?: { email?: string; merchantId?: string };
  /** What is being bought, shown to the user at PayPal checkout. */
  item?: { name: string; quantity: number; unitAmountUSD: string };
  /** Tag stored on the order so we can tell top-ups and purchases apart. */
  customId?: string;
  returnUrl?: string;
  cancelUrl?: string;
}

/** Create a PayPal order for a USD amount. Returns the approval link. */
export async function createOrder(
  amountUSD: string,
  description: string,
  opts: OrderOptions = {},
): Promise<PaypalOrder> {
  const token = await paypalAccessToken();
  const unit: any = {
    amount: { currency_code: "USD", value: amountUSD },
    description: description.slice(0, 127),
  };
  if (opts.customId) unit.custom_id = opts.customId.slice(0, 127);
  if (opts.payee?.merchantId) unit.payee = { merchant_id: opts.payee.merchantId };
  else if (opts.payee?.email) unit.payee = { email_address: opts.payee.email };
  if (opts.item) {
    unit.amount.breakdown = { item_total: { currency_code: "USD", value: amountUSD } };
    unit.items = [
      {
        name: opts.item.name.slice(0, 127),
        quantity: String(opts.item.quantity),
        unit_amount: { currency_code: "USD", value: opts.item.unitAmountUSD },
      },
    ];
  }
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [unit],
      application_context: {
        brand_name: BRAND_NAME,
        user_action: "PAY_NOW",
        return_url: opts.returnUrl ?? "https://example.com/agentpay/return",
        cancel_url: opts.cancelUrl ?? "https://example.com/agentpay/cancel",
      },
    }),
  });
  if (!res.ok) throw new Error(`PayPal createOrder failed: ${res.status} ${await res.text()}`);
  const json: any = await res.json();
  const approveUrl = (json.links ?? []).find((l: any) => l.rel === "approve")?.href;
  return { id: json.id, status: json.status, approveUrl };
}

/** Capture an approved PayPal order. Returns the capture result. */
export async function captureOrder(orderId: string): Promise<{
  status: string;
  captureId?: string;
  amountUSD?: string;
  payerId?: string;
  raw: any;
}> {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`PayPal capture failed: ${res.status} ${JSON.stringify(json)}`);
  const cap = json?.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    status: json.status,
    captureId: cap?.id,
    amountUSD: cap?.amount?.value,
    payerId: json?.payer?.payer_id,
    raw: json,
  };
}

/**
 * Read an order's current state: whether the human approved it, which PayPal
 * account approved it, and the tag it was created with.
 */
export async function getOrder(orderId: string): Promise<{
  status: string;
  payerId?: string;
  customId?: string;
  amountUSD?: string;
  raw: any;
}> {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`PayPal getOrder failed: ${res.status} ${JSON.stringify(json)}`);
  const unit = json?.purchase_units?.[0];
  return {
    status: json.status,
    payerId: json?.payer?.payer_id,
    customId: unit?.custom_id,
    amountUSD: unit?.amount?.value,
    raw: json,
  };
}

/**
 * Pay a merchant from this app's own PayPal balance (Payouts API). Used for
 * automatic payments, where the user has pre-funded the wallet.
 */
export async function sendPayout(
  receiver: string,
  amountUSD: string,
  note: string,
): Promise<{ payoutId: string; status: string }> {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v1/payments/payouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: `agentic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        email_subject: `Payment from ${BRAND_NAME}`,
      },
      items: [
        {
          recipient_type: receiver.includes("@") ? "EMAIL" : "PAYPAL_ID",
          receiver,
          amount: { value: amountUSD, currency: "USD" },
          note: note.slice(0, 127),
        },
      ],
    }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`PayPal payout failed: ${res.status} ${JSON.stringify(json)}`);
  return {
    payoutId: json?.batch_header?.payout_batch_id,
    status: json?.batch_header?.batch_status,
  };
}
