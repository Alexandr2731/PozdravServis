import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";
import crypto from "node:crypto";

// Интеграция с ЮKassa (приём оплаты) — https://yookassa.ru/developers/api
// Требует YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY в окружении. Оба сначала пробуем в
// тестовом режиме (тестовые ключи ЮKassa из того же личного кабинета), боевые — только
// после того как весь флоу (оплата → вебхук → генерация) проверен без реальных денег
// (см. knowledge/discovery-2026-09-22/03-validation-plan.md).

const API_BASE = "https://api.yookassa.ru/v3";

function authHeader() {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secretKey) {
    throw new Error("YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не заданы — добавь в .env (локально) или Railway Variables (прод)");
  }
  return "Basic " + Buffer.from(`${shopId}:${secretKey}`).toString("base64");
}

/**
 * Создаёт платёж и возвращает ссылку на оплату (confirmation_url), куда нужно отправить
 * клиента. Idempotence-Key обязателен у ЮKassa — без него повторный сетевой сбой на этом
 * же запросе создаст два разных платежа вместо одного (см. fetchWithTimeout — сеть на
 * практике действительно иногда рвётся на середине запроса).
 *
 * @param {object} params
 * @param {number} params.amountRub — сумма в рублях (не копейках), например 990
 * @param {string} params.description — что покупает клиент, видно клиенту и в кабинете ЮKassa
 * @param {string} params.returnUrl — куда вернуть клиента после оплаты (страница/бот)
 * @param {{email?: string, phone?: string}} params.customer — нужен email ИЛИ phone для чека (54-ФЗ)
 * @param {string} [params.idempotenceKey] — свой ключ идемпотентности; по умолчанию генерируется
 */
export async function createPayment({ amountRub, description, returnUrl, customer, idempotenceKey }) {
  if (!customer?.email && !customer?.phone) {
    throw new Error("Нужен email или телефон клиента — обязателен для чека по 54-ФЗ");
  }

  const res = await fetchWithTimeout(`${API_BASE}/payments`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      "Idempotence-Key": idempotenceKey || crypto.randomUUID(),
    },
    body: JSON.stringify({
      amount: { value: amountRub.toFixed(2), currency: "RUB" },
      capture: true, // списываем сразу при подтверждении, без отдельного шага "захват платежа"
      confirmation: { type: "redirect", return_url: returnUrl },
      description,
      receipt: {
        customer,
        items: [
          {
            description,
            quantity: "1",
            amount: { value: amountRub.toFixed(2), currency: "RUB" },
            vat_code: 1, // без НДС — уточнить у бухгалтера/при регистрации ИП, если ставка другая
            payment_subject: "service",
            payment_mode: "full_payment",
          },
        ],
      },
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`YooKassa createPayment error: ${JSON.stringify(json)}`);
  }
  return { paymentId: json.id, confirmationUrl: json.confirmation?.confirmation_url, status: json.status };
}

/**
 * Проверяет реальный статус платежа напрямую у ЮKassa по своим ключам — а не доверяет
 * телу вебхука вслепую. Вебхук говорит "иди проверь платёж X", а не "плати за то, что я
 * скажу" — так убираем риск, что кто-то пришлёт поддельный POST на webhook-урл и получит
 * бесплатную генерацию.
 */
export async function getPayment(paymentId) {
  const res = await fetchWithTimeout(`${API_BASE}/payments/${paymentId}`, {
    headers: { Authorization: authHeader() },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`YooKassa getPayment error: ${JSON.stringify(json)}`);
  }
  return json; // json.status: "pending" | "waiting_for_capture" | "succeeded" | "canceled"
}
