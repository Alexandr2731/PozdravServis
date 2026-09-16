import { Scenes, Markup } from "telegraf";
import { generateGreetingVideo, cloneVoiceFromAudio } from "../services/heygen.js";
import { convertOggToMp3 } from "../utils/audio.js";

const OCCASIONS = [
  ["birthday", "🎂 День рождения"],
  ["newyear", "🎄 Новый год"],
  ["march8", "💐 8 Марта"],
  ["feb23", "🎖 23 Февраля"],
  ["feb14", "❤️ 14 Февраля"],
  ["wedding", "💍 Свадьба / годовщина"],
  ["birth", "👶 Рождение ребёнка"],
  ["graduation", "🎓 Выпускной"],
  ["love", "💌 Признание в любви"],
  ["other", "✨ Без повода / другое"],
];

const occasionKeyboard = Markup.inlineKeyboard(
  OCCASIONS.map(([code, label]) => Markup.button.callback(label, `occasion:${code}`)),
  { columns: 2 }
);

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
    const label = OCCASIONS.find(([c]) => c === code)?.[1] ?? code;
    ctx.wizard.state.occasion = label;
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
    await ctx.answerCbQuery();
    if (choice === "help") {
      await ctx.reply(
        "Автоматическое написание текста/стиха пока в разработке — скоро будет доступно.\n\n" +
          "А пока пришли, пожалуйста, свой текст поздравления."
      );
    } else {
      await ctx.reply("Пришли текст поздравления.");
    }
    return ctx.wizard.next();
  },
  (ctx) => {
    const text = ctx.message?.text;
    if (!text) {
      ctx.reply("Нужен текст поздравления. Попробуй ещё раз.");
      return;
    }
    ctx.wizard.state.text = text;
    ctx.reply("Теперь пришли фото, которое станет основой поздравления.");
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
    if (style === "cartoon") {
      await ctx.reply(
        "Мультяшный стиль пока в разработке — сделаем в обычном (реалистичном).\n\n" +
          "Хочешь, чтобы поздравление звучало голосом того, кто поздравляет?\n\n" +
          "Пришли голосовое сообщение (10-30 секунд, чётко и без шума) — или нажми кнопку, чтобы использовать стандартный голос.",
        voiceKeyboard
      );
    } else {
      await ctx.reply(
        "Хочешь, чтобы поздравление звучало голосом того, кто поздравляет?\n\n" +
          "Пришли голосовое сообщение (10-30 секунд, чётко и без шума) — или нажми кнопку, чтобы использовать стандартный голос.",
        voiceKeyboard
      );
    }
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
