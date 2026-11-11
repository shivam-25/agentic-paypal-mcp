import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTPAY_HOME } from "./config.js";

/**
 * The demo store's catalogue, and a local log of the orders the agent has
 * created. The log is what the dashboard shows; PayPal stays the source of
 * truth for whether an order was actually paid.
 */

export const STORE_NAME = "Fernhill Goods";

export interface Product {
  id: string;
  name: string;
  description: string;
  priceUSD: string;
}

export const PRODUCTS: Product[] = [
  { id: "mug", name: "Stoneware mug", description: "Hand-glazed, 12 oz.", priceUSD: "18.00" },
  { id: "tote", name: "Canvas tote", description: "Heavy cotton, inside pocket.", priceUSD: "24.00" },
  { id: "notebooks", name: "Notebook set", description: "Three dot-grid notebooks.", priceUSD: "12.00" },
  { id: "lamp", name: "Desk lamp", description: "Dimmable, warm light.", priceUSD: "39.00" },
  { id: "coffee", name: "Coffee beans", description: "Medium roast, 12 oz bag.", priceUSD: "16.00" },
  { id: "socks", name: "Wool socks", description: "Two pairs, merino blend.", priceUSD: "14.00" },
];

export interface OrderRecord {
  id: string;
  kind: "purchase" | "topup";
  item: string;
  merchant?: string;
  amountUSD: string;
  status: "awaiting_approval" | "paid";
  approveUrl?: string;
  createdAt: string;
  paidAt?: string;
  /** Paid from the wallet without asking, because it was within the user's limit. */
  auto?: boolean;
}

const ORDERS_FILE = join(AGENTPAY_HOME, "orders.json");

export function loadOrders(): OrderRecord[] {
  if (!existsSync(ORDERS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(ORDERS_FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as OrderRecord[]) : [];
  } catch {
    return [];
  }
}

function saveOrders(orders: OrderRecord[]) {
  try {
    writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  } catch {
    // The log is a convenience for the dashboard; never fail a payment over it.
  }
}

/** Log an order the agent just created and the user still has to approve. */
export function recordOrder(order: Omit<OrderRecord, "status" | "createdAt">) {
  const orders = loadOrders().filter((o) => o.id !== order.id);
  orders.unshift({ ...order, status: "awaiting_approval", createdAt: new Date().toISOString() });
  saveOrders(orders.slice(0, 200));
}

/** Mark a logged order as paid once PayPal has captured it. */
export function markOrderPaid(id: string) {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === id);
  if (!order) return;
  order.status = "paid";
  order.paidAt = new Date().toISOString();
  delete order.approveUrl;
  saveOrders(orders);
}

/** Log a purchase that was paid automatically from the wallet. */
export function recordAutoPaidOrder(order: Pick<OrderRecord, "id" | "kind" | "item" | "merchant" | "amountUSD">) {
  const now = new Date().toISOString();
  const orders = loadOrders();
  orders.unshift({ ...order, status: "paid", auto: true, createdAt: now, paidAt: now });
  saveOrders(orders.slice(0, 200));
}
