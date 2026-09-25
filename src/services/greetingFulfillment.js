import { Markup } from "telegraf";
import { generateGreetingVideo, cloneVoiceFromAudio, deleteVoice } from "./heygen.js";
import { stylizeCartoon } from "./openai.js";
import { convertOggToMp3 } from "../utils/audio.js";
import { updateOrder } from "../utils/orderStore.js";
import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

// Отделено от greeting.js: вызывается в конце сценария (greeting.js, startGeneration) по уже
// оплаченному заказу и работает после выхода из сцены — поэтому берёт всё из заказа, а не из wizard.state.
//
// РЕШЕНО 2026-09-23 (голосом, Александр): без бесплатной переделки видео — HeyGen стоит
// реальных денег за каждый прогон, в отличие от текста, где есть 1 переделка (2+2 варианта).
// Клиент уже согласовал текст на предыдущем шаге (в greeting.js) —
// единственная случайная величина, которая остаётся, это как ИИ на самом деле
// анимировал фото. Поэтому сразу развилка: забрал результат, или отказ со скидкой на
// следующий заказ (promoStore.js) — без промежуточного бесплатного передела.

function reviewKeyboard(orderId, isFreeTrial) {
  // Бесплатная проба: отказываться не от чего — только «Забрать».
  if (isFreeTrial) return Markup.inlineKeyboard([Markup.button.callback("✅ Забрать", `greeting:accept:${orderId}`)]);
  return Markup.inlineKeyboard([
    Markup.button.callback("✅ Забрать", `greeting:accept:${orderId}`),
    Markup.button.callback("🎟 Не подошло — скидка 50% на следующее", `greeting:decline:${orderId}`),
  ]);
}

/** Генерирует видео по уже оплаченному заказу и присылает клиенту с кнопками отзыва. */
export async function fulfillGreetingOrder(telegram, order) {
  // fetchWithTimeout, не голый fetch — скачивание с серверов Telegram иногда зависает
  // посреди запроса на этой инфраструктуре (см. тот же фикс в greeting.js, найдено живым
  // тестом 23.09.2026).
  const photoFileLink = await telegram.getFileLink(order.photoFileId);
  let photoBuffer = Buffer.from(await (await fetchWithTimeout(photoFileLink.href, {})).arrayBuffer());

  // Мультяшный стиль — подключено и тестируется 23.09.2026 (было заглушкой "в разработке").
  // Отдельный платный вызов OpenAI (gpt-image-1) поверх HeyGen — стоимость учитывать отдельно
  // при определении цены для этого стиля, себестоимость выше реалистичного на эту сумму.
  if (order.videoStyle === "cartoon") {
    photoBuffer = await stylizeCartoon(photoBuffer);
  }

  let voiceId;
  if (order.voiceFileId) {
    const voiceFileLink = await telegram.getFileLink(order.voiceFileId);
    const oggBuffer = Buffer.from(await (await fetchWithTimeout(voiceFileLink.href, {})).arrayBuffer());
    const mp3Buffer = await convertOggToMp3(oggBuffer);
    voiceId = await cloneVoiceFromAudio(mp3Buffer);
  }

  let videoUrl;
  try {
    videoUrl = await generateGreetingVideo({ photoBuffer, text: order.text, voiceId });
  } finally {
    // Клон нужен только на эту генерацию — освобождаем слот (у тарифа HeyGen их всего 2).
    if (voiceId) await deleteVoice(voiceId).catch((err) => console.error("deleteVoice failed:", err));
  }

  updateOrder(order.orderId, { variants: [...order.variants, videoUrl], status: "awaiting_review" });

  await telegram.sendVideo(order.chatId, videoUrl, {
    caption: "Готово! Вот Ваше поздравление 🎉",
    ...reviewKeyboard(order.orderId, order.isFreeTrial),
  });
}

/**
 * Запуск генерации в фоне (до 10 минут) с обработкой сбоя: клиенту — понятное сообщение без
 * технических подробностей (живой тест 25.09.2026 показал ему сырой JSON ошибки HeyGen) и
 * кнопка повтора — всё собранное (текст, фото, голос) лежит в заказе, сценарий заново не нужен.
 */
export function runGreetingFulfillment(telegram, order) {
  updateOrder(order.orderId, { status: "generating" });
  fulfillGreetingOrder(telegram, order).catch(async (err) => {
    console.error("fulfillGreetingOrder failed:", order.orderId, err);
    updateOrder(order.orderId, { status: "failed", error: err.message });
    await telegram
      .sendMessage(
        order.chatId,
        "😔 К сожалению, видео не получилось из-за технического сбоя на нашей стороне. Приносим извинения!\n\n" +
          "Ваш текст, фото и голос сохранены — нажмите «Попробовать ещё раз», заново ничего проходить не нужно. " +
          "Если не получится и со второй попытки — напишите нам, разберёмся.",
        Markup.inlineKeyboard([Markup.button.callback("🔄 Попробовать ещё раз", `greeting:retry:${order.orderId}`)])
      )
      .catch(() => {});
  });
}
