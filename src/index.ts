import "dotenv/config.js";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import { fetchCTFTimeEvents, type CTFTimeEvent } from "./ctftime.js";
import { getScheduledEvents, isEventScheduled, markEventScheduled, markEventNotified, cleanupFinishedEvents } from "./db.js";
import { startTracking, stopTracking } from "./ctfd.js";
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

function scheduleEventNotification(event: CTFTimeEvent, options: { force?: boolean } = {}): void {
  const { force = false } = options;

  if (!force && isEventScheduled(event.id)) {
    return;
  }

  const startTime = new Date(event.start);
  const now = new Date();
  const timeUntilStart = startTime.getTime() - now.getTime();

  // If event already started, skip it
  if (timeUntilStart <= 0) {
    return;
  }

  // Use setTimeout for one-time notification
  setTimeout(() => {
    const message = formatEventDetails(event, true);
    bot.sendMessage(chatId, message, { parse_mode: "MarkdownV2" })
      .catch((error) => console.error("Error sending notification:", error));
    markEventNotified(event.id);
  }, timeUntilStart);

  markEventScheduled(event);
  console.log(`Scheduled notification for "${event.title}" at ${startTime.toISOString()}`);
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

bot.onText(/!ctf$/, async (msg) => {
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

bot.onText(/!ctfd\s+(.+)/, async (msg, match) => {
  if (!match || !match[1]) {
    await bot.sendMessage(
      msg.chat.id,
      "Usage: `!ctfd <ctfd_url> <team_name> <access_token> <end_time>`\n\nExample:\n`!ctfd https://ctf.example.com \"Team Alpha\" abc123token \"2025-12-10 23:59\"`",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  const args = match[1].trim();
  
  const quotedMatch = args.match(/^(\S+)\s+"([^"]+)"\s+(\S+)\s+(.+)$/);
  const simpleMatch = args.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);

  let ctfdUrl: string;
  let teamName: string;
  let accessToken: string;
  let endTimeStr: string;

  if (quotedMatch) {
    ctfdUrl = quotedMatch[1] || "";
    teamName = quotedMatch[2] || "";
    accessToken = quotedMatch[3] || "";
    endTimeStr = quotedMatch[4] || "";
  } else if (simpleMatch) {
    ctfdUrl = simpleMatch[1] || "";
    teamName = simpleMatch[2] || "";
    accessToken = simpleMatch[3] || "";
    endTimeStr = simpleMatch[4] || "";
  } else {
    await bot.sendMessage(
      msg.chat.id,
      "Invalid format\\. Use: `!ctfd <ctfd_url> <team_name> <access_token> <end_time>`",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  // Parse end time
  const endTime = dayjs.tz(endTimeStr.trim(), "YYYY-MM-DD HH:mm", "Asia/Jakarta").toDate();
  
  if (isNaN(endTime.getTime())) {
    await bot.sendMessage(
      msg.chat.id,
      "Invalid end time format\\. Use format: `YYYY-MM-DD HH:mm` \\(WIB\\)\n\nExample: `2025-12-10 23:59`",
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  await bot.sendMessage(msg.chat.id, "Starting CTFd tracking\\.\\.\\.", { parse_mode: "MarkdownV2" });

  const result = await startTracking(msg.chat.id, ctfdUrl.trim(), teamName.trim(), accessToken.trim(), endTime, bot);
  
  await bot.sendMessage(msg.chat.id, escapeMarkdownV2(result), { parse_mode: "MarkdownV2" });
});

bot.onText(/!ctfd\s+stop/, async (msg) => {
  stopTracking(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "CTFd tracking stopped\\.", { parse_mode: "MarkdownV2" });
});

bot.on("message", (msg) => {
  console.log("Message received:", msg.text);
});
