import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Общее хранилище заказов, клиентов и промокодов (ДАННЫЕ-1, решение Александра 25.09.2026:
// российская PostgreSQL в Timeweb Cloud — 152-ФЗ).
//
// Как устроено: при старте бот загружает все записи в память (их немного — сотни/тысячи),
// читает из памяти синхронно, а каждое изменение сразу записывает в базу (upsert одной
// записи, по очереди, с повторами при сбое сети). Так остальной код бота остался простым
// (синхронные getOrder/updateOrder), а данные живут в базе и переживают любой деплой.
// Годится, пока бот — ОДИН процесс: у сервиса на Railway подключён Volume, а с ним Railway
// не запускает старый и новый контейнеры одновременно. При переходе на несколько процессов
// кэш в памяти нужно убрать и читать из базы напрямую.
//
// Без DATABASE_URL (локальный запуск) — прежние JSON-файлы в data/.
//
// Таблицы: orders, users, promos — id, user_id, status (для удобного просмотра в веб-интерфейсе
// Timeweb), data (вся запись как JSON), updated_at.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const CA_FILE = join(__dirname, "..", "..", "certs", "timeweb-ca.crt");

// Коллекция -> JSON-файл прежнего хранилища (из него же — разовый перенос в базу).
const COLLECTIONS = {
  orders: "greetingOrders.json",
  users: "users.json",
  promos: "promos.json",
};

const cache = new Map(); // коллекция -> { id: запись }
let pool = null;
const pending = new Set(); // незавершённые записи в базу — дожидаемся при остановке

function readJsonFile(name) {
  const file = join(DATA_DIR, COLLECTIONS[name]);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonFile(name) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, COLLECTIONS[name]), JSON.stringify(cache.get(name), null, 2), "utf8");
}

async function upsert(name, id, doc) {
  await pool.query(
    `insert into ${name} (id, user_id, status, data, updated_at) values ($1, $2, $3, $4, now())
     on conflict (id) do update set user_id = excluded.user_id, status = excluded.status,
       data = excluded.data, updated_at = now()`,
    [id, doc.userId ?? null, doc.status ?? null, doc]
  );
}

/** Подключение к базе, создание таблиц, загрузка записей в память. Вызвать до приёма апдейтов. */
export async function initDocStore() {
  if (!process.env.DATABASE_URL) {
    for (const name of Object.keys(COLLECTIONS)) cache.set(name, readJsonFile(name));
    console.log("docStore: DATABASE_URL не задан — храним в JSON-файлах (data/)");
    return;
  }

  // Пароль — отдельной переменной DATABASE_PASSWORD: спецсимволы в нём ломают строку
  // подключения. Строку разбираем сами и передаём поля по отдельности: pg при connectionString
  // затирает переданный рядом password пустым (найдено проверкой на локальной PostgreSQL).
  const url = new URL(process.env.DATABASE_URL);
  pool = new pg.Pool({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: process.env.DATABASE_PASSWORD || decodeURIComponent(url.password),
    // Timeweb требует защищённое подключение с проверкой сертификата их CA.
    // DATABASE_SSL=off — только для локальной проверки на своей PostgreSQL без сертификата.
    ssl: process.env.DATABASE_SSL === "off" ? false : { ca: readFileSync(CA_FILE, "utf8"), rejectUnauthorized: true },
    max: 5,
  });

  for (const name of Object.keys(COLLECTIONS)) {
    await pool.query(
      `create table if not exists ${name} (
         id text primary key,
         user_id text,
         status text,
         data jsonb not null,
         updated_at timestamptz not null default now()
       )`
    );
    const { rows } = await pool.query(`select id, data from ${name}`);
    const docs = Object.fromEntries(rows.map((r) => [r.id, r.data]));

    // Разовый перенос: таблица пустая, а в data/ остались записи прежнего хранилища.
    // Файлы не удаляем — остаются резервной копией.
    if (rows.length === 0) {
      const legacy = readJsonFile(name);
      for (const [id, doc] of Object.entries(legacy)) {
        await upsert(name, id, doc);
        docs[id] = doc;
      }
      if (Object.keys(legacy).length) console.log(`docStore: перенесено в ${name}: ${Object.keys(legacy).length}`);
    }
    cache.set(name, docs);
  }
  console.log("docStore: PostgreSQL подключена, записи загружены");
}

/** Все записи коллекции (живой объект из памяти — только для чтения). */
export function allDocs(name) {
  const docs = cache.get(name);
  if (!docs) throw new Error(`docStore не инициализирован (коллекция ${name})`);
  return docs;
}

/** Сохраняет запись: в память сразу, в базу — в фоне, по порядку, с повторами. */
export function saveDoc(name, id, doc) {
  allDocs(name)[id] = doc;
  if (!pool) {
    writeJsonFile(name);
    return;
  }
  const job = persistWithRetry(name, id).finally(() => pending.delete(job));
  pending.add(job);
}

// Очередь по записи: следующее сохранение той же записи ждёт предыдущее — в базе не окажется
// более старая версия поверх новой. Пишется актуальная версия из памяти на момент записи.
const chains = new Map();
function persistWithRetry(name, id) {
  const key = `${name}:${id}`;
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await upsert(name, id, allDocs(name)[id]);
        return;
      } catch (err) {
        console.error(`docStore: не записалось ${key} (попытка ${attempt}):`, err.message);
        if (attempt >= 5) return; // запись остаётся в памяти; следующее сохранение повторит
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  });
  chains.set(key, next);
  next.finally(() => chains.get(key) === next && chains.delete(key));
  return next;
}

/** Дождаться записи всех изменений в базу (при остановке процесса). */
export async function flushDocStore() {
  await Promise.allSettled([...pending]);
  await pool?.end();
}
