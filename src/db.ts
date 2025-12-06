import fs from "node:fs";
import { type CTFTimeEvent } from "./ctftime.js";

const DB_PATH = "./database/events.json";

interface ScheduledEvent extends CTFTimeEvent {
  scheduled: boolean;
  notified: boolean;
}

function loadEvents(): ScheduledEvent[] {
  try {
    const data = fs.readFileSync(DB_PATH, "utf-8");
    return JSON.parse(data) as ScheduledEvent[];
  } catch {
    return [];
  }
}

function saveEvents(events: ScheduledEvent[]): void {
  fs.writeFileSync(DB_PATH, JSON.stringify(events, null, 2));
}

export function getScheduledEvents(): ScheduledEvent[] {
  return loadEvents();
}

export function isEventScheduled(eventId: number): boolean {
  const events = loadEvents();
  return events.some((e) => e.id === eventId && e.scheduled);
}

export function markEventScheduled(event: CTFTimeEvent): void {
  const events = loadEvents();
  const existingIndex = events.findIndex((e) => e.id === event.id);

  if (existingIndex >= 0 && events[existingIndex]) {
    const existing = events[existingIndex];
    events[existingIndex] = {
      ...event,
      scheduled: true,
      notified: existing.notified,
    };
  } else {
    events.push({
      ...event,
      scheduled: true,
      notified: false,
    });
  }

  saveEvents(events);
}

export function markEventNotified(eventId: number): void {
  const events = loadEvents();
  const event = events.find((e) => e.id === eventId);
  if (event) {
    event.notified = true;
    saveEvents(events);
  }
}

export function cleanupFinishedEvents(): void {
  const events = loadEvents();
  const now = new Date();
  const activeEvents = events.filter((event) => {
    const endTime = new Date(event.finish);
    return endTime > now;
  });
  saveEvents(activeEvents);
}
