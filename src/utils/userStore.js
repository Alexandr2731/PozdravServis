import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Клиенты по Telegram ID (решение Александра 25.09.2026, knowledge/tasks.md ФЛОУ-1):
// - первый визит и источник — метка из ссылки t.me/<бот>?start=<метка> (реклама, блогер,
//   ref_<ID> — рекомендация другого клиента), нужна для маркетинга и будущей реферальной
//   программы. Записывается ОДИН раз, при первом входе, — повторный вход по другой ссылке
//   источник не перезаписывает;
// - какие бесплатные пробы клиент уже получил (по одной на услугу).
// Тот же JSON-файл на диске, что orderStore.js, — временно, до БД (ДАННЫЕ-1).

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const USERS_FILE = join(DATA_DIR, "users.json");

function readAll() {
  if (!existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(users) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

// Метка приходит от клиента (любой может подставить свою ссылку) — оставляем только то,
// что Telegram вообще допускает в start-параметре: латиница, цифры, _ и -, до 64 символов.
function cleanSource(raw) {
  const source = String(raw ?? "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(source) ? source : null;
}

/**
 * Регистрирует клиента при первом /start; при повторных — только обновляет lastSeenAt.
 * @returns {{ user: object, isNew: boolean }}
 */
export function registerVisit(from, startPayload) {
  const userId = String(from.id);
  const users = readAll();
  const now = new Date().toISOString();
  const existing = users[userId];
  if (existing) {
    existing.lastSeenAt = now;
    writeAll(users);
    return { user: existing, isNew: false };
  }
  const source = cleanSource(startPayload);
  const referrer = source?.startsWith("ref_") ? source.slice(4) : null;
  users[userId] = {
    userId,
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    source,
    referrerId: referrer && referrer !== userId ? referrer : null,
    firstSeenAt: now,
    lastSeenAt: now,
    freeTrialsUsed: {},
  };
  writeAll(users);
  return { user: users[userId], isNew: true };
}

/** Получал ли клиент уже бесплатную пробу этой услуги. */
export function hasUsedFreeTrial(userId, service) {
  return Boolean(readAll()[userId]?.freeTrialsUsed?.[service]);
}

/** Отмечает бесплатную пробу услуги использованной (orderId — заказ, на который она ушла). */
export function markFreeTrialUsed(userId, service, orderId) {
  const users = readAll();
  if (!users[userId]) throw new Error(`Клиент ${userId} не найден`);
  users[userId].freeTrialsUsed = { ...users[userId].freeTrialsUsed, [service]: { orderId, at: new Date().toISOString() } };
  writeAll(users);
}
