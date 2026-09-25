import { allDocs, saveDoc } from "./docStore.js";
import crypto from "node:crypto";

// Заказы Услуги 1 (анимированное поздравление) — в PostgreSQL через docStore.js (таблица orders).
// Хранятся вне session() Telegraf: она не переживает рестарт, а платёж может прийти уже после него.

const readAll = () => allDocs("orders");

export function createOrder(data) {
  const orderId = crypto.randomUUID();
  const orders = readAll();
  orders[orderId] = { ...data, orderId, revisionCount: 0, variants: [], createdAt: new Date().toISOString() };
  saveDoc("orders", orderId, orders[orderId]);
  return orderId;
}

export function getOrder(orderId) {
  return readAll()[orderId];
}

// previousPaymentIds — ссылки, выданные раньше (кнопка «Оплатить» в черновиках создаёт новую):
// клиент мог оплатить и по старой — такой платёж тоже должен найти свой заказ.
export function getOrderByPaymentId(paymentId) {
  const orders = readAll();
  return Object.values(orders).find((o) => o.paymentId === paymentId || o.previousPaymentIds?.includes(paymentId));
}

/** Все заказы клиента, новые первыми. */
export function listUserOrders(userId) {
  return Object.values(readAll())
    .filter((o) => o.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateOrder(orderId, patch) {
  const orders = readAll();
  if (!orders[orderId]) throw new Error(`Заказ ${orderId} не найден`);
  orders[orderId] = { ...orders[orderId], ...patch };
  saveDoc("orders", orderId, orders[orderId]);
  return orders[orderId];
}

// Оплаченный, но ещё не доведённый до генерации заказ клиента. Нужен, чтобы оплата не
// терялась: сцена (session() Telegraf) не переживает рестарт процесса, а клиент может
// бросить сценарий на середине — по /start он продолжит с тем же оплаченным заказом,
// а не заплатит второй раз.
export function findUnfinishedPaidOrder(userId) {
  return Object.values(readAll())
    .filter((o) => o.userId === userId && (o.status === "paid" || o.status === "in_progress"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
