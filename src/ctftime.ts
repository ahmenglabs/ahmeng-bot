import fetch from "node-fetch";

export interface CTFTimeOrganizer {
  id: number;
  name: string;
}

export interface CTFTimeDuration {
  hours: number;
  days: number;
}

export interface CTFTimeEvent {
  organizers: CTFTimeOrganizer[];
  ctftime_url: string;
  ctf_id: number;
  weight: number;
  duration: CTFTimeDuration;
  live_feed: string;
  logo: string;
  id: number;
  title: string;
  start: string;
  participants: number;
  location: string;
  finish: string;
  description: string;
  format: string;
  is_votable_now: boolean;
  prizes: string;
  format_id: number;
  onsite: boolean;
  restrictions: string;
  url: string;
  public_votable: boolean;
}

export async function fetchCTFTimeEvents(): Promise<CTFTimeEvent[]> {
  const now = Math.floor(Date.now() / 1000);
  const oneWeekLater = now + 7 * 24 * 60 * 60;

  const url = `https://ctftime.org/api/v1/events/?limit=100&start=${now}&finish=${oneWeekLater}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`CTFTime API error: ${response.status} ${response.statusText}`);
    }

    const events = (await response.json()) as CTFTimeEvent[];
    return events;
  } catch (error) {
    console.error("Error fetching CTFTime events:", error);
    throw error;
  }
}
