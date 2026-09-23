import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

// Заказы Услуги 1 (анимированное поздравление) между "создан платёж" и "оплата
// подтверждена вебхуком" — тот же простой JSON-файл на диске, что и balanceStore.js
// (см. её же обоснование: session() Telegraf не переживает рестарт процесса на Railway,
// а платёж может прийти уже после рестарта). Не замена БД, временное решение до Supabase.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const ORDERS_FILE = join(DATA_DIR, "greetingOrders.json");

function readAll() {
  if (!existsSync(ORDERS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ORDERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(orders) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), "utf8");
}

export function createOrder(data) {
  const orderId = crypto.randomUUID();
  const orders = readAll();
  orders[orderId] = { ...data, orderId, revisionCount: 0, variants: [], createdAt: new Date().toISOString() };
  writeAll(orders);
  return orderId;
}

export function getOrder(orderId) {
  return readAll()[orderId];
}

export function getOrderByPaymentId(paymentId) {
  const orders = readAll();
  return Object.values(orders).find((o) => o.paymentId === paymentId);
}

export function updateOrder(orderId, patch) {
  const orders = readAll();
  if (!orders[orderId]) throw new Error(`Заказ ${orderId} не найден`);
  orders[orderId] = { ...orders[orderId], ...patch };
  writeAll(orders);
  return orders[orderId];
}
