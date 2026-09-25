import { Markup } from "telegraf";
import { listUserOrders } from "../utils/orderStore.js";

// Папки клиента (решение Александра 25.09.2026):
// - «📝 Черновики» — всё начатое и не завершённое: не оплачено, оплачено но не заполнено,
//   создаётся, сбой при создании, готово но клиент ещё не решил (забрать / не подошло);
// - «🎬 Мои поздравления» — забранные готовые видео, чтобы прислать их снова.

const DRAFT_STATUSES = new Set(["awaiting_payment", "paid", "in_progress", "generating", "failed", "awaiting_review"]);

export function getDraftOrders(userId) {
  const drafts = listUserOrders(userId).filter((o) => DRAFT_STATUSES.has(o.status));
  // Неоплаченных может накопиться несколько («Купить» нажимали не раз) — показываем только
  // самый свежий, остальные не трогаем: по их старым ссылкам ещё могут заплатить (вебхук найдёт).
  const newestUnpaid = drafts.find((o) => o.status === "awaiting_payment");
  return drafts.filter((o) => o.status !== "awaiting_payment" || o === newestUnpaid);
}

export function getReadyOrders(userId) {
  return listUserOrders(userId).filter((o) => o.status === "delivered");
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit" });
}

function orderTitle(order) {
  // Повод у незаполненного заказа лежит в черновике; сам ярлык повода уже с эмодзи («🎂 День рождения»).
  const what = order.occasion ?? order.draft?.state?.occasion ?? "🎬 Поздравление";
  return `${what}${order.isFreeTrial ? " (пробное)" : ""} · ${formatDate(order.createdAt)}`;
}

// Статус черновика -> пояснение и кнопка действия.
function draftAction(order) {
  switch (order.status) {
    case "awaiting_payment":
      return { note: "ожидает оплаты", button: ["💳 Оплатить", `greeting:pay:${order.orderId}`] };
    case "paid":
    case "in_progress":
      return { note: "оплачено, не заполнено", button: ["▶️ Продолжить", `greeting:start:${order.orderId}`] };
    case "generating":
      return { note: "создаётся, до 10 минут", button: ["⏳ Создаётся…", "folders:generating"] };
    case "failed":
      return { note: "сбой при создании", button: ["🔄 Попробовать ещё раз", `greeting:retry:${order.orderId}`] };
    case "awaiting_review":
      return { note: "готово, ждёт Вашего решения", button: ["👀 Посмотреть", `greeting:show:${order.orderId}`] };
    default:
      return null;
  }
}

export function draftsMessage(userId) {
  const drafts = getDraftOrders(userId);
  if (!drafts.length) return { text: "📝 Черновиков нет — всё начатое завершено. Новое поздравление — /start." };
  const lines = drafts.map((o, i) => `${i + 1}. ${orderTitle(o)} — ${draftAction(o).note}`);
  const rows = drafts.map((o, i) => {
    const [label, data] = draftAction(o).button;
    return [Markup.button.callback(`${i + 1}. ${label}`, data)];
  });
  return { text: `📝 Ваши черновики:\n\n${lines.join("\n")}`, extra: Markup.inlineKeyboard(rows) };
}

export function readyMessage(userId) {
  const ready = getReadyOrders(userId);
  if (!ready.length) return { text: "🎬 Готовых поздравлений пока нет. Создать — /start." };
  const rows = ready.map((o) => [Markup.button.callback(`📥 ${orderTitle(o)}`, `greeting:video:${o.orderId}`)]);
  return { text: "🎬 Ваши поздравления — нажмите, чтобы получить видео ещё раз:", extra: Markup.inlineKeyboard(rows) };
}

/** Главное меню: услуги + папки (кнопка папки видна, только если в ней что-то есть). */
export function mainMenuKeyboard(userId) {
  const drafts = getDraftOrders(userId).length;
  const ready = getReadyOrders(userId).length;
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎬 Анимированное поздравление", "service:video")],
    [Markup.button.callback("🎵 Поздравительная песня — скоро", "service:soon")],
    [Markup.button.callback("🎞 Поздравительный клип — скоро", "service:soon")],
    ...(drafts ? [[Markup.button.callback(`📝 Черновики (${drafts})`, "folders:drafts")]] : []),
    ...(ready ? [[Markup.button.callback(`🎬 Мои поздравления (${ready})`, "folders:ready")]] : []),
  ]);
}
