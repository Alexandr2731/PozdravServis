import { Telegraf, Scenes, session } from "telegraf";
import { greetingWizard } from "./scenes/greeting.js";

const bot = new Telegraf(process.env.BOT_TOKENNP);
const stage = new Scenes.Stage([greetingWizard]);

bot.use(session());
bot.use(stage.middleware());

bot.start((ctx) =>
  ctx.reply(
    "Привет! Я помогу создать необычное поздравление.\n\n" +
      "1 — Анимированное видео-поздравление\n" +
      "2 — Именная песня + клип\n\n" +
      "Напиши 1 или 2, чтобы начать."
  )
);

bot.hears("1", (ctx) => ctx.scene.enter("greeting-wizard"));

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
