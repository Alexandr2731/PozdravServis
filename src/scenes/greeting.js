import { Scenes, Markup } from "telegraf";
import { generateGreetingVideo } from "../services/heygen.js";

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
    await ctx.reply(`Повод: ${label}\n\nТеперь пришли фото, которое станет основой поздравления.`);
    return ctx.wizard.next();
  },
  (ctx) => {
    const photo = ctx.message?.photo?.at(-1);
    if (!photo) {
      ctx.reply("Нужно именно фото. Попробуй ещё раз.");
      return;
    }
    ctx.wizard.state.photoFileId = photo.file_id;
    ctx.reply("Теперь пришли текст поздравления.");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const text = ctx.message?.text;
    if (!text) {
      ctx.reply("Нужен текст поздравления. Попробуй ещё раз.");
      return;
    }
    ctx.reply("Собираю поздравление, это займёт пару минут...");
    try {
      const fileLink = await ctx.telegram.getFileLink(ctx.wizard.state.photoFileId);
      const photoBuffer = Buffer.from(await (await fetch(fileLink.href)).arrayBuffer());
      const videoUrl = await generateGreetingVideo({ photoBuffer, text });
      await ctx.reply(`Готово! ${videoUrl}`);
    } catch (err) {
      await ctx.reply(`Не получилось создать видео: ${err.message}`);
    }
    return ctx.scene.leave();
  }
);
