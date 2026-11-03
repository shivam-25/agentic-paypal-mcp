import {
  PAYPAL_API_BASE,
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  assertPaypalConfigured,
} from "./config.js";

/**
 * Thin PayPal REST client (Orders API v2) for the fiat rail. Used to let a
 * human top up the agent's USD balance, and for the agent to pay a PayPal
 * order directly. Runs against the sandbox by default.
 */

let _token: { value: string; exp: number } | null = null;

export async function paypalAccessToken(): Promise<string> {
  assertPaypalConfigured();
  if (_token && Date.now() < _token.exp - 60_000) return _token.value;
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const json: any = await res.json();
  _token = { value: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return _token.value;
}

export interface PaypalOrder {
  id: string;
  status: string;
  approveUrl?: string;
}

/** Create a PayPal order for a USD amount. Returns the approval link. */
export async function createOrder(
  amountUSD: string,
  description: string,
  returnUrl = "https://example.com/agentpay/return",
  cancelUrl = "https://example.com/agentpay/cancel",
): Promise<PaypalOrder> {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: amountUSD },
          description: description.slice(0, 127),
        },
      ],
      application_context: {
        brand_name: "AgentPay",
        user_action: "PAY_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
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
    raw: json,
  };
}

/** Read an order's current status (to poll whether the human approved it). */
export async function getOrder(orderId: string): Promise<{ status: string; raw: any }> {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`PayPal getOrder failed: ${res.status} ${JSON.stringify(json)}`);
  return { status: json.status, raw: json };
}
