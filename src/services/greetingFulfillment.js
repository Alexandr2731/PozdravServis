import { Markup } from "telegraf";
import { generateGreetingVideo, cloneVoiceFromAudio } from "./heygen.js";
import { convertOggToMp3 } from "../utils/audio.js";
import { updateOrder } from "../utils/orderStore.js";
import { hasFreeRevisionsLeft, canOfferRefund, refundAmount } from "../utils/revisionRules.js";

// Отделено от greeting.js: вызывается и сразу после оплаты (из вебхука ЮKassa в bot.js —
// там нет доступа к Telegraf wizard.state, заказ уже вне сцены), и при бесплатной
// переделке (тоже вне сцены — кнопка "Переделать" под уже присланным видео).

function reviewKeyboard(orderId, revisionCount) {
  const buttons = [Markup.button.callback("👍 Нравится", `greeting:like:${orderId}`)];
  if (hasFreeRevisionsLeft(revisionCount)) {
    buttons.push(Markup.button.callback("✏️ Переделать бесплатно", `greeting:redo:${orderId}`));
  } else if (canOfferRefund(revisionCount)) {
    buttons.push(Markup.button.callback("💰 Вернуть баллами", `greeting:refund:${orderId}`));
  }
  return Markup.inlineKeyboard(buttons);
}

/** Генерирует видео по уже оплаченному заказу и присылает клиенту с кнопками отзыва. */
export async function fulfillGreetingOrder(bot, order) {
  const photoFileLink = await bot.telegram.getFileLink(order.photoFileId);
  const photoBuffer = Buffer.from(await (await fetch(photoFileLink.href)).arrayBuffer());

  let voiceId;
  if (order.voiceFileId) {
    const voiceFileLink = await bot.telegram.getFileLink(order.voiceFileId);
    const oggBuffer = Buffer.from(await (await fetch(voiceFileLink.href)).arrayBuffer());
    const mp3Buffer = await convertOggToMp3(oggBuffer);
    voiceId = await cloneVoiceFromAudio(mp3Buffer);
  }

  const videoUrl = await generateGreetingVideo({ photoBuffer, text: order.text, voiceId });

  const updated = updateOrder(order.orderId, { variants: [...order.variants, videoUrl] });

  await bot.telegram.sendVideo(order.chatId, videoUrl, {
    caption: "Готово! Вот твоё поздравление 🎉",
    ...reviewKeyboard(order.orderId, updated.revisionCount),
  });
}
