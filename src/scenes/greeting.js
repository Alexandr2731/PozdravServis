import { Scenes, Markup } from "telegraf";
import { generateGreetingVideo, cloneVoiceFromAudio } from "../services/heygen.js";
import { generateGreetingText, transcribeVoice } from "../services/openai.js";
import { convertOggToMp3 } from "../utils/audio.js";
import { occasionKeyboard, occasionLabel } from "../constants/occasions.js";

const textSourceKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("✍️ У меня свой текст", "textsrc:own"),
  Markup.button.callback("🤖 Помоги написать", "textsrc:help"),
]);

const styleKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("🎥 Обычный (реалистичный)", "style:realistic"),
  Markup.button.callback("🎨 Мультяшный", "style:cartoon"),
]);

const voiceKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("🔊 Стандартный голос", "voice:default"),
]);

async function transcribeIfVoice(ctx, voice) {
  const voiceFileLink = await ctx.telegram.getFileLink(voice.file_id);
  const oggBuffer = Buffer.from(await (await fetch(voiceFileLink.href)).arrayBuffer());
  const mp3Buffer = await convertOggToMp3(oggBuffer);
  return transcribeVoice(mp3Buffer);
}

export const greetingWizard = new Scenes.WizardScene(
  "greeting-wizard",
  (ctx) => {
    ctx.reply("По какому поводу поздравление?", occasionKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const code = ctx.callbackQuery?.data?.split(":")[1];
    if (!code) {
      ctx.reply("Выбери повод кнопкой выше.");
      return;
    }
    ctx.wizard.state.occasion = occasionLabel(code);
    await ctx.answerCbQuery();
    await ctx.reply("У тебя уже есть текст или стих поздравления, или помочь его написать?", textSourceKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const choice = ctx.callbackQuery?.data?.split(":")[1];
    if (!choice) {
      ctx.reply("Выбери кнопкой выше.");
      return;
    }
    ctx.wizard.state.textMode = choice;
    await ctx.answerCbQuery();
    if (choice === "help") {
      await ctx.reply("Расскажи о человеке, кого поздравляем: имя, что любит, за что цените.");
    } else {
      await ctx.reply("Пришли текст поздравления — текстом или голосовым сообщением.");
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    const typed = ctx.message?.text;
    const voice = ctx.message?.voice;
    if (!typed && !voice) {
      ctx.reply("Пришли текст или голосовое сообщение.");
      return;
    }
    try {
      if (ctx.wizard.state.textMode === "help") {
        const personInfo = typed || (await transcribeIfVoice(ctx, voice));
        await ctx.reply("Пишу текст поздравления...");
        const text = await generateGreetingText({ occasion: ctx.wizard.state.occasion, personInfo });
        ctx.wizard.state.text = text;
        await ctx.reply(`Вот что получилось:\n\n${text}`);
      } else {
        ctx.wizard.state.text = typed || (await transcribeIfVoice(ctx, voice));
      }
    } catch (err) {
      await ctx.reply(`Не получилось обработать: ${err.message}`);
      return;
    }
    await ctx.reply("Теперь пришли фото, которое станет основой поздравления.");
    return ctx.wizard.next();
  },
  (ctx) => {
    const photo = ctx.message?.photo?.at(-1);
    if (!photo) {
      ctx.reply("Нужно именно фото. Попробуй ещё раз.");
      return;
    }
    ctx.wizard.state.photoFileId = photo.file_id;
    ctx.reply("В каком стиле сделать видео?", styleKeyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const style = ctx.callbackQuery?.data?.split(":")[1];
    if (!style) {
      ctx.reply("Выбери стиль кнопкой выше.");
      return;
    }
    await ctx.answerCbQuery();
    const prefix =
      style === "cartoon" ? "Мультяшный стиль пока в разработке — сделаем в обычном (реалистичном).\n\n" : "";
    await ctx.reply(
      prefix +
        "Хочешь, чтобы поздравление звучало голосом того, кто поздравляет?\n\n" +
        "Пришли голосовое сообщение (10-30 секунд, чётко и без шума) — или нажми кнопку, чтобы использовать стандартный голос.",
      voiceKeyboard
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const isSkip = ctx.callbackQuery?.data === "voice:default";
    const voice = ctx.message?.voice;
    if (!isSkip && !voice) {
      ctx.reply("Пришли голосовое сообщение или нажми кнопку «Стандартный голос».");
      return;
    }
    if (isSkip) await ctx.answerCbQuery();

    await ctx.reply("Собираю поздравление, это займёт пару минут...");
    try {
      const fileLink = await ctx.telegram.getFileLink(ctx.wizard.state.photoFileId);
      const photoBuffer = Buffer.from(await (await fetch(fileLink.href)).arrayBuffer());

      let voiceId;
      if (voice) {
        const voiceFileLink = await ctx.telegram.getFileLink(voice.file_id);
        const oggBuffer = Buffer.from(await (await fetch(voiceFileLink.href)).arrayBuffer());
        const mp3Buffer = await convertOggToMp3(oggBuffer);
        voiceId = await cloneVoiceFromAudio(mp3Buffer);
      }

      const videoUrl = await generateGreetingVideo({
        photoBuffer,
        text: ctx.wizard.state.text,
        voiceId,
      });
      await ctx.replyWithVideo(videoUrl, { caption: "Готово! Вот твоё поздравление 🎉" });
    } catch (err) {
      await ctx.reply(`Не получилось создать видео: ${err.message}`);
    }
    return ctx.scene.leave();
  }
);
