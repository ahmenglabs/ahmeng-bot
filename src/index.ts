import "dotenv/config.js";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import { fetchCTFTimeEvents, type CTFTimeEvent } from "./ctftime.js";
import { getScheduledEvents, isEventScheduled, markEventScheduled, markEventNotified, cleanupFinishedEvents } from "./db.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is not defined in environment variables");
}

if (!process.env.TELEGRAM_CHAT_ID) {
  throw new Error("TELEGRAM_CHAT_ID is not defined in environment variables");
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const chatId = process.env.TELEGRAM_CHAT_ID;

function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function formatDate(date: Date): string {
  return dayjs(date).tz("Asia/Jakarta").format("dddd, DD MMMM YYYY HH:mm") + " WIB";
}

function formatEventDetails(event: CTFTimeEvent, includeStarting: boolean = false): string {
  const startDate = new Date(event.start);
  const endDate = new Date(event.finish);

  const totalMinutes = event.duration.days * 24 * 60 + event.duration.hours * 60;
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const title = escapeMarkdownV2(event.title);
  const url = escapeMarkdownV2(event.url);
  const weightStr = escapeMarkdownV2(event.weight.toFixed(2));
  const participantsStr = escapeMarkdownV2(event.participants.toString());

  const titleLine = includeStarting ? `*${title} STARTING!*` : `*${title}*`;

  return `${titleLine}

Start: *${formatDate(startDate)}*
End: *${formatDate(endDate)}*
Duration: *${days}* days *${hours}* hours *${minutes}* minutes
Weight: *${weightStr}*
Participants: *${participantsStr}* teams

URL: ${url}`;
}

function formatEventMessage(event: CTFTimeEvent): string {
  return formatEventDetails(event, true);
}

function scheduleEventNotification(event: CTFTimeEvent, options: { force?: boolean } = {}): void {
  const { force = false } = options;

  if (!force && isEventScheduled(event.id)) {
    return;
  }

  const startTime = new Date(event.start);
  const now = new Date();

  if (startTime <= now) {
    return;
  }

  const cronDate = new Date(startTime);
  const cronExpression = `${cronDate.getMinutes()} ${cronDate.getHours()} ${cronDate.getDate()} ${cronDate.getMonth() + 1} *`;

  cron.schedule(cronExpression, () => {
    const message = formatEventMessage(event);
    bot.sendMessage(chatId, message, { parse_mode: "MarkdownV2" });
    markEventNotified(event.id);
  });

  markEventScheduled(event);
}

async function fetchAndScheduleEvents(): Promise<void> {
  try {
    cleanupFinishedEvents();

    const events = await fetchCTFTimeEvents();
    const filteredEvents = events.filter((event) => event.format === "Jeopardy" && event.onsite === false);

    for (const event of filteredEvents) {
      scheduleEventNotification(event);
    }
  } catch (error) {
    console.error("Error fetching and scheduling events:", error);
  }
}

function loadScheduledEventsOnStartup(): void {
  const events = getScheduledEvents();
  const now = new Date();

  for (const event of events) {
    const startTime = new Date(event.start);

    if (startTime > now && !event.notified) {
      scheduleEventNotification(event, { force: true });
    }
  }
}

loadScheduledEventsOnStartup();
fetchAndScheduleEvents();
cron.schedule("0 * * * *", () => {
  fetchAndScheduleEvents();
});

bot.onText(/!ctf/, async (msg) => {
  const events = getScheduledEvents();
  const now = new Date();
  const upcomingEvents = events.filter((event) => {
    const startTime = new Date(event.start);
    return startTime > now && !event.notified;
  });

  if (upcomingEvents.length === 0) {
    await bot.sendMessage(msg.chat.id, "No upcoming CTF events", { parse_mode: "MarkdownV2" });
    return;
  }

  const messages = upcomingEvents.map((event) => formatEventDetails(event));

  const fullMessage = `*UPCOMING CTF*\n\n${messages.join("\n\n\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\n\n")}`;
  await bot.sendMessage(msg.chat.id, fullMessage, { parse_mode: "MarkdownV2" });
});

bot.on("message", (msg) => {
  console.log("Message received:", msg.text);
});
