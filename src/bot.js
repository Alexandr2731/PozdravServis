import { createServer } from "node:http";
import { Telegraf, Scenes, session, Markup } from "telegraf";
import { greetingWizard } from "./scenes/greeting.js";

createServer((_req, res) => res.end("ok")).listen(process.env.PORT || 3000);

const bot = new Telegraf(process.env.BOT_TOKENNP);
const stage = new Scenes.Stage([greetingWizard]);

bot.use(session());
bot.use(stage.middleware());

const serviceKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("🎬 Анимированное видео-поздравление", "service:video"),
  Markup.button.callback("🎵 Именная песня + клип", "service:song"),
]);

bot.start((ctx) =>
  ctx.reply(
    `Привет, ${ctx.from.first_name || "друг"}! 👋\n\n` +
      "Я — «На память», помогаю создавать необычные поздравления с помощью ИИ.\n\n" +
      "🎬 Оживлю фото — человек на нём сам зачитает поздравление\n" +
      "🎵 Или напишем и сгенерируем именную песню с клипом в честь того, кого поздравляете\n\n" +
      "С чего начнём?",
    serviceKeyboard
  )
);

bot.action("service:video", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.scene.enter("greeting-wizard");
});

bot.action("service:song", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Именная песня + клип пока в разработке, скоро будет доступна.");
});

bot.help((ctx) =>
  ctx.reply(
    "Как это работает:\n\n" +
      "1. Выбери тип поздравления командой /start\n" +
      "2. Пришли фото и текст поздравления\n" +
      "3. Дождись готового видео (пара минут)\n\n" +
      "/start — начать новое поздравление"
  )
);

bot.telegram.setMyCommands([
  { command: "start", description: "Начать новое поздравление" },
  { command: "help", description: "Как это работает" },
]);

bot.launch();

process.once("SIGTERM", () => bot.stop("SIGTERM"));
process.once("SIGINT", () => bot.stop("SIGINT"));
