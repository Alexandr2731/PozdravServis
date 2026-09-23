import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Персистентный баланс баллов на клиента (Telegram user id) — перенесено из
// den-rozhdeniya (birthday-service/src/orchestrator/balanceStore.ts), 2026-09-23.
// Закрывает P0 "баллы/баланс невозможны — нет БД" временно, до перехода на Supabase:
// обычная переменная в памяти (как session()) не переживает перезапуск процесса на
// Railway, а баллы за возврат должны — иначе обещание "вернём половину баллами" не
// работает при любом передеплое. Простой JSON-файл на диске, без внешних зависимостей.
//
// ВАЖНО: это временная затычка, не замена БД. При нескольких параллельных процессах
// (несколько инстансов бота одновременно) плоский файл даст гонку записи — нормально
// для одного процесса на Railway сейчас, но перепроверить при масштабировании или
// переходе на Supabase (см. критический разбор плана, 02.10.2026).

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const BALANCES_FILE = join(DATA_DIR, "balances.json");

function readAll() {
  if (!existsSync(BALANCES_FILE)) return {};
  try {
    return JSON.parse(readFileSync(BALANCES_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(balances) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BALANCES_FILE, JSON.stringify(balances, null, 2), "utf8");
}

export function getBalance(userId) {
  return readAll()[userId] ?? 0;
}

/** Начисляет баллы (например, возврат за неудачный этап) — points может быть дробным, округляем при показе клиенту. */
export function addPoints(userId, points) {
  const balances = readAll();
  const next = (balances[userId] ?? 0) + points;
  balances[userId] = next;
  writeAll(balances);
  return next;
}

/** Списывает баллы (клиент использовал их при оплате следующего заказа). Бросает, если баланса не хватает. */
export function spendPoints(userId, points) {
  const balances = readAll();
  const current = balances[userId] ?? 0;
  if (current < points) {
    throw new Error(`Недостаточно баллов: на счету ${current}, требуется ${points}`);
  }
  const next = current - points;
  balances[userId] = next;
  writeAll(balances);
  return next;
}
