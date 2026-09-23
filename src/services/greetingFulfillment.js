import { Markup } from "telegraf";
import { generateGreetingVideo, cloneVoiceFromAudio } from "./heygen.js";
import { stylizeCartoon } from "./openai.js";
import { convertOggToMp3 } from "../utils/audio.js";
import { updateOrder } from "../utils/orderStore.js";

// Отделено от greeting.js: вызывается из вебхука ЮKassa в bot.js после оплаты — там нет
// доступа к Telegraf wizard.state, заказ уже вне сцены к этому моменту.
//
// РЕШЕНО 2026-09-23 (голосом, Александр): без бесплатной переделки видео — HeyGen стоит
// реальных денег за каждый прогон, в отличие от текста (GPT-4o-mini), где переделка
// бесплатна и без ограничений. Клиент уже согласовал текст на предыдущем шаге (в greeting.js,
// до оплаты) — единственная случайная величина, которая остаётся, это как ИИ на самом деле
// анимировал фото. Поэтому сразу развилка: забрал результат, или отказ с возвратом половины
// стоимости баллами — без промежуточного бесплатного передела.

function reviewKeyboard(orderId) {
  return Markup.inlineKeyboard([
    Markup.button.callback("✅ Забрать", `greeting:accept:${orderId}`),
    Markup.button.callback("💰 Отказаться — вернуть половину баллами", `greeting:refund:${orderId}`),
  ]);
}

/** Генерирует видео по уже оплаченному заказу и присылает клиенту с кнопками отзыва. */
export async function fulfillGreetingOrder(bot, order) {
  const photoFileLink = await bot.telegram.getFileLink(order.photoFileId);
  let photoBuffer = Buffer.from(await (await fetch(photoFileLink.href)).arrayBuffer());

  // Мультяшный стиль — подключено и тестируется 23.09.2026 (было заглушкой "в разработке").
  // Отдельный платный вызов OpenAI (gpt-image-1) поверх HeyGen — стоимость учитывать отдельно
  // при определении цены для этого стиля, себестоимость выше реалистичного на эту сумму.
  if (order.videoStyle === "cartoon") {
    photoBuffer = await stylizeCartoon(photoBuffer);
  }

  let voiceId;
  if (order.voiceFileId) {
    const voiceFileLink = await bot.telegram.getFileLink(order.voiceFileId);
    const oggBuffer = Buffer.from(await (await fetch(voiceFileLink.href)).arrayBuffer());
    const mp3Buffer = await convertOggToMp3(oggBuffer);
    voiceId = await cloneVoiceFromAudio(mp3Buffer);
  }

  const videoUrl = await generateGreetingVideo({ photoBuffer, text: order.text, voiceId });

  updateOrder(order.orderId, { variants: [...order.variants, videoUrl] });

  await bot.telegram.sendVideo(order.chatId, videoUrl, {
    caption: "Готово! Вот твоё поздравление 🎉",
    ...reviewKeyboard(order.orderId),
  });
}
