import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";

// CTFd API Types
interface CTFdChallenge {
  id: number;
  name: string;
  category: string;
  value: number;
}

interface CTFdSolve {
  challenge_id: number;
  challenge: {
    id: number;
    name: string;
    category: string;
    value: number;
  };
  user: {
    id: number;
    name: string;
  };
  team: {
    id: number;
    name: string;
  };
  date: string;
}

interface CTFdTeam {
  id: number;
  name: string;
  score: number;
  place: string;
}

interface CTFdScoreboard {
  standings: CTFdTeam[];
}

// Tracking Session State
interface TrackingSession {
  chatId: number;
  ctfdUrl: string;
  teamName: string;
  accessToken: string;
  teamId: number | null;
  knownSolves: Set<number>;
  pollInterval: NodeJS.Timeout | null;
  summaryTimeout: NodeJS.Timeout | null;
  endTime: Date;
  totalChallenges: number;
}

// In-memory tracker for active sessions (one per chat)
const activeSessions = new Map<number, TrackingSession>();

// Helper to escape MarkdownV2
function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// Fetch team info by name
async function findTeamByName(ctfdUrl: string, teamName: string, token: string): Promise<CTFdTeam | null> {
  try {
    const url = `${ctfdUrl}/api/v1/scoreboard`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) return null;

    const data = await response.json() as { success: boolean; data: CTFdScoreboard };
    if (!data.success) return null;

    const team = data.data.standings.find(
      (t: CTFdTeam) => t.name.toLowerCase() === teamName.toLowerCase()
    );

    return team || null;
  } catch (error) {
    console.error("Error finding team:", error);
    return null;
  }
}

// Fetch team solves
async function fetchTeamSolves(ctfdUrl: string, teamId: number, token: string): Promise<CTFdSolve[]> {
  try {
    const url = `${ctfdUrl}/api/v1/teams/${teamId}/solves`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) return [];

    const data = await response.json() as { success: boolean; data: CTFdSolve[] };
    if (!data.success) return [];

    return data.data;
  } catch (error) {
    console.error("Error fetching solves:", error);
    return [];
  }
}

// Fetch all challenges to get total count
async function fetchChallenges(ctfdUrl: string, token: string): Promise<number> {
  try {
    const url = `${ctfdUrl}/api/v1/challenges`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) return 0;

    const data = await response.json() as { success: boolean; data: CTFdChallenge[] };
    if (!data.success) return 0;

    return data.data.length;
  } catch (error) {
    console.error("Error fetching challenges:", error);
    return 0;
  }
}

// Fetch current team rank and total teams
async function fetchTeamRank(ctfdUrl: string, teamId: number, token: string): Promise<{ rank: string; totalTeams: number }> {
  try {
    const url = `${ctfdUrl}/api/v1/scoreboard`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) return { rank: "?", totalTeams: 0 };

    const data = await response.json() as { success: boolean; data: CTFdScoreboard };
    if (!data.success) return { rank: "?", totalTeams: 0 };

    const standings = data.data.standings;
    const teamIndex = standings.findIndex((t: CTFdTeam) => t.id === teamId);

    return {
      rank: teamIndex >= 0 ? String(teamIndex + 1) : "?",
      totalTeams: standings.length,
    };
  } catch (error) {
    console.error("Error fetching rank:", error);
    return { rank: "?", totalTeams: 0 };
  }
}

// Format solve notification
function formatSolveNotification(
  teamName: string,
  challengeName: string,
  category: string,
  points: number,
  rank: string,
  totalTeams: number
): string {
  return `*CHALLENGE SOLVED*

Team name: *${escapeMarkdownV2(teamName)}*
Chall name: *${escapeMarkdownV2(challengeName)}*
Category: *${escapeMarkdownV2(category)}*
Points: *${points}*
Current rank: *${rank}/${totalTeams}*`;
}

// Format summary message
function formatSummary(
  teamName: string,
  solveCount: number,
  totalChallenges: number,
  totalPoints: number,
  rank: string,
  totalTeams: number
): string {
  return `*CTF SUMMARY*

Team name: *${escapeMarkdownV2(teamName)}*
Total solves: *${solveCount}/${totalChallenges}*
Total points: *${totalPoints}*
Current rank: *${rank}/${totalTeams}*`;
}

// Poll for new solves
async function pollSolves(chatId: number, bot: TelegramBot): Promise<void> {
  const session = activeSessions.get(chatId);
  if (!session || session.teamId === null) return;

  const solves = await fetchTeamSolves(session.ctfdUrl, session.teamId, session.accessToken);

  for (const solve of solves) {
    if (!session.knownSolves.has(solve.challenge_id)) {
      session.knownSolves.add(solve.challenge_id);

      // Fetch current rank
      const { rank, totalTeams } = await fetchTeamRank(
        session.ctfdUrl,
        session.teamId,
        session.accessToken
      );

      // Send notification
      const message = formatSolveNotification(
        session.teamName,
        solve.challenge.name,
        solve.challenge.category,
        solve.challenge.value,
        rank,
        totalTeams
      );

      await bot.sendMessage(chatId, message, { parse_mode: "MarkdownV2" });
    }
  }
}

// Send summary and stop tracking
async function sendSummary(chatId: number, bot: TelegramBot): Promise<void> {
  const session = activeSessions.get(chatId);
  if (!session || session.teamId === null) return;

  const solves = await fetchTeamSolves(session.ctfdUrl, session.teamId, session.accessToken);
  const { rank, totalTeams } = await fetchTeamRank(session.ctfdUrl, session.teamId, session.accessToken);

  const totalPoints = solves.reduce((sum, solve) => sum + solve.challenge.value, 0);

  const message = formatSummary(
    session.teamName,
    solves.length,
    session.totalChallenges,
    totalPoints,
    rank,
    totalTeams
  );

  await bot.sendMessage(chatId, message, { parse_mode: "MarkdownV2" });

  // Cleanup
  stopTracking(chatId);
}

// Stop tracking for a chat
export function stopTracking(chatId: number): void {
  const session = activeSessions.get(chatId);
  if (!session) return;

  if (session.pollInterval) {
    clearInterval(session.pollInterval);
  }

  if (session.summaryTimeout) {
    clearTimeout(session.summaryTimeout);
  }

  activeSessions.delete(chatId);
}

// Start tracking a team
export async function startTracking(
  chatId: number,
  ctfdUrl: string,
  teamName: string,
  accessToken: string,
  endTime: Date,
  bot: TelegramBot
): Promise<string> {
  // Stop any existing session for this chat
  stopTracking(chatId);

  // Validate end time is in the future
  const now = new Date();
  if (endTime <= now) {
    return "Error: CTF has already ended";
  }

  // Find team by name
  const team = await findTeamByName(ctfdUrl, teamName, accessToken);
  if (!team) {
    return `Error: Team "${teamName}" not found`;
  }

  // Fetch total challenges
  const totalChallenges = await fetchChallenges(ctfdUrl, accessToken);

  // Fetch initial solves
  const initialSolves = await fetchTeamSolves(ctfdUrl, team.id, accessToken);
  const knownSolves = new Set(initialSolves.map((s) => s.challenge_id));

  // Create session
  const session: TrackingSession = {
    chatId,
    ctfdUrl,
    teamName,
    accessToken,
    teamId: team.id,
    knownSolves,
    pollInterval: null,
    summaryTimeout: null,
    endTime,
    totalChallenges,
  };

  activeSessions.set(chatId, session);

  // Start polling every 30 seconds
  session.pollInterval = setInterval(() => {
    pollSolves(chatId, bot);
  }, 30000);

  // Schedule summary 2 minutes before end
  const timeUntilSummary = endTime.getTime() - now.getTime() - 2 * 60 * 1000;
  if (timeUntilSummary > 0) {
    session.summaryTimeout = setTimeout(() => {
      sendSummary(chatId, bot);
    }, timeUntilSummary);
  } else {
    // CTF ends in less than 2 minutes, send summary immediately
    await sendSummary(chatId, bot);
    return "CTF ends in less than 2 minutes. Summary sent.";
  }

  return `Started tracking team "${teamName}". Will send summary 2 minutes before CTF ends.`;
}
