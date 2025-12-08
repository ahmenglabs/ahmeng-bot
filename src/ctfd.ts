import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import fs from "node:fs";

// CTFd API Types
interface CTFdChallenge {
  id: number;
  name: string;
  category: string;
  value: number;
  solves?: number;
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
  notifiedSolves: Set<number>;
  pollInterval: NodeJS.Timeout | null;
  summaryTimeout: NodeJS.Timeout | null;
  endTime: Date;
  totalChallenges: number;
}

// Persistable session data (for saving to file)
interface PersistedSession {
  chatId: number;
  ctfdUrl: string;
  teamName: string;
  accessToken: string;
  teamId: number | null;
  knownSolves: number[];
  notifiedSolves: number[];
  endTime: string;
  totalChallenges: number;
}

// In-memory tracker for active sessions (one per chat)
const activeSessions = new Map<number, TrackingSession>();

const CTFD_DB_PATH = "./database/ctfd_sessions.json";

// Load persisted sessions from file
function loadPersistedSessions(): PersistedSession[] {
  try {
    const data = fs.readFileSync(CTFD_DB_PATH, "utf-8");
    return JSON.parse(data) as PersistedSession[];
  } catch {
    return [];
  }
}

// Save active sessions to file
function saveActiveSessions(): void {
  const sessions: PersistedSession[] = [];
  
  for (const [chatId, session] of activeSessions.entries()) {
    sessions.push({
      chatId,
      ctfdUrl: session.ctfdUrl,
      teamName: session.teamName,
      accessToken: session.accessToken,
      teamId: session.teamId,
      knownSolves: Array.from(session.knownSolves),
      notifiedSolves: Array.from(session.notifiedSolves),
      endTime: session.endTime.toISOString(),
      totalChallenges: session.totalChallenges,
    });
  }
  
  fs.writeFileSync(CTFD_DB_PATH, JSON.stringify(sessions, null, 2));
}

// Helper to escape MarkdownV2
function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// Helper to clean rank string (remove ordinal suffixes)
function cleanRank(rank: string): string {
  return rank.replace(/(st|nd|rd|th)$/i, "");
}

// Fetch team info by name (with pagination support)
async function findTeamByName(ctfdUrl: string, teamName: string, token: string): Promise<CTFdTeam | null> {
  try {
    // Try /teams endpoint first (supports pagination)
    let page = 1;
    while (true) {
      const url = `${ctfdUrl}/api/v1/teams?page=${page}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        console.log(`Teams page ${page} response not OK:`, response.status, response.statusText);
        break;
      }

      const json = await response.json() as { success?: boolean; data?: CTFdTeam[]; meta?: { pagination?: { pages?: number } } };
      console.log(`Teams API response (page ${page}):`, JSON.stringify(json, null, 2));
      
      if (json.success === false || !json.data) break;

      // Search in current page
      const team = json.data.find(
        (t: CTFdTeam) => t.name.toLowerCase() === teamName.toLowerCase()
      );

      if (team) return team;

      // Check if there are more pages
      const totalPages = json.meta?.pagination?.pages ?? 1;
      if (page >= totalPages) break;

      page++;
    }

    // Fallback to scoreboard endpoint
    console.log("Team not found in /teams, trying /scoreboard...");
    const scoreboardUrl = `${ctfdUrl}/api/v1/scoreboard`;
    const scoreboardResponse = await fetch(scoreboardUrl, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!scoreboardResponse.ok) {
      console.log("Scoreboard response not OK:", scoreboardResponse.status, scoreboardResponse.statusText);
      return null;
    }

    const scoreboardJson = await scoreboardResponse.json() as { success?: boolean; data?: unknown; standings?: unknown };
    console.log("Scoreboard API response:", JSON.stringify(scoreboardJson, null, 2));
    if (scoreboardJson.success === false) return null;

    // Support varied shapes: { data: { standings: [] } } or { data: [] } or { standings: [] }
    const standingsCandidate = (scoreboardJson as any)?.data?.standings ?? (scoreboardJson as any)?.data ?? (scoreboardJson as any)?.standings ?? [];
    const standings: CTFdTeam[] = Array.isArray(standingsCandidate) ? standingsCandidate : [];

    const team = standings.find(
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

    if (!response.ok) {
      console.log("Team solves response not OK:", response.status, response.statusText);
      return [];
    }

    const data = await response.json() as { success: boolean; data: CTFdSolve[] };
    console.log(`Team ${teamId} solves API response:`, JSON.stringify(data, null, 2));
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

    if (!response.ok) {
      console.log("Challenges response not OK:", response.status, response.statusText);
      return 0;
    }

    const data = await response.json() as { success: boolean; data: CTFdChallenge[] };
    console.log("Challenges API response:", JSON.stringify(data, null, 2));
    if (!data.success) return 0;

    return data.data.length;
  } catch (error) {
    console.error("Error fetching challenges:", error);
    return 0;
  }
}

// Fetch event name from CTFd config
async function fetchEventName(ctfdUrl: string, token: string): Promise<string> {
  try {
    const url = `${ctfdUrl}/api/v1/config`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log("Config response not OK:", response.status, response.statusText);
      return "Unknown Event";
    }

    const data = await response.json() as { success: boolean; data: any[] };
    console.log("Config API response:", JSON.stringify(data, null, 2));
    
    if (!data.success || !data.data) return "Unknown Event";

    // Look for ctf_name or similar config
    const ctfNameConfig = data.data.find((config: any) => config.key === "ctf_name" || config.key === "name");
    return ctfNameConfig?.value || "Unknown Event";
  } catch (error) {
    console.error("Error fetching event name:", error);
    return "Unknown Event";
  }
}
async function fetchTeamRank(ctfdUrl: string, teamId: number, token: string): Promise<{ rank: string; totalTeams: number }> {
  try {
    // Try scoreboard first (usually has ranking info)
    const url = `${ctfdUrl}/api/v1/scoreboard`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log("Team rank scoreboard response not OK:", response.status, response.statusText);
      return { rank: "?", totalTeams: 0 };
    }

    const json = await response.json() as { success?: boolean; data?: unknown; standings?: unknown };
    console.log("Team rank API response:", JSON.stringify(json, null, 2));
    if (json.success === false) return { rank: "?", totalTeams: 0 };

    const standingsCandidate = (json as any)?.data?.standings ?? (json as any)?.data ?? (json as any)?.standings ?? [];
    const standings: CTFdTeam[] = Array.isArray(standingsCandidate) ? standingsCandidate : [];

    if (standings.length > 0) {
      // Find the team and use its place field or index
      const team = standings.find((t: CTFdTeam) => t.id === teamId);
      if (team) {
        // Use place field if available, otherwise use index
        const rank = team.place || String(standings.findIndex((t: CTFdTeam) => t.id === teamId) + 1);
        return {
          rank: rank,
          totalTeams: standings.length,
        };
      }
    }

    // Fallback: get team info from /teams/{id} endpoint
    console.log("Team not in scoreboard, fetching from /teams endpoint...");
    const teamUrl = `${ctfdUrl}/api/v1/teams/${teamId}`;
    const teamResponse = await fetch(teamUrl, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (teamResponse.ok) {
      const teamJson = await teamResponse.json() as { success?: boolean; data?: CTFdTeam };
      if (teamJson.success !== false && teamJson.data?.place) {
        // Count total teams
        let totalTeams = 0;
        let page = 1;
        while (true) {
          const teamsUrl = `${ctfdUrl}/api/v1/teams?page=${page}`;
          const teamsResponse = await fetch(teamsUrl, {
            headers: {
              Authorization: `Token ${token}`,
              "Content-Type": "application/json",
            },
          });

          if (!teamsResponse.ok) break;

          const teamsJson = await teamsResponse.json() as { success?: boolean; data?: CTFdTeam[]; meta?: { pagination?: { pages?: number; total?: number } } };
          if (teamsJson.success === false || !teamsJson.data) break;

          totalTeams = teamsJson.meta?.pagination?.total ?? totalTeams + teamsJson.data.length;
          const totalPages = teamsJson.meta?.pagination?.pages ?? 1;
          
          if (page >= totalPages) break;
          page++;
        }

        return { rank: teamJson.data.place, totalTeams };
      }
    }

    return { rank: "?", totalTeams: 0 };
  } catch (error) {
    console.error("Error fetching rank:", error);
    return { rank: "?", totalTeams: 0 };
  }
}

// Format solve notification
function formatSolveNotification(
  eventName: string,
  teamName: string,
  challengeName: string,
  category: string,
  points: number,
  rank: string,
  totalTeams: number,
  solverName: string,
  currentPoints: number
): string {
  const cleanRankStr = cleanRank(rank);
  return `*CHALLENGE SOLVED*

Event name: *${escapeMarkdownV2(eventName)}*
Team name: *${escapeMarkdownV2(teamName)}*
Chall name: *${escapeMarkdownV2(challengeName)}*
Category: *${escapeMarkdownV2(category)}*
Points: *${points}*
Current rank: *${cleanRankStr}/${totalTeams}*
Current points: *${currentPoints}*

*SOLVED BY ${escapeMarkdownV2(solverName)}*`;
}

// Format summary message
function formatSummary(
  eventName: string,
  teamName: string,
  solveCount: number,
  totalChallenges: number,
  totalPoints: number,
  rank: string,
  totalTeams: number
): string {
  const cleanRankStr = cleanRank(rank);
  return `*CTF SUMMARY*

Event name: *${escapeMarkdownV2(eventName)}*
Team name: *${escapeMarkdownV2(teamName)}*
Total solves: *${solveCount}/${totalChallenges}*
Total points: *${totalPoints}*
Current rank: *${cleanRankStr}/${totalTeams}*`;
}

// Poll for new solves
async function pollSolves(chatId: number, bot: TelegramBot): Promise<void> {
  const session = activeSessions.get(chatId);
  if (!session || session.teamId === null) return;

  const solves = await fetchTeamSolves(session.ctfdUrl, session.teamId, session.accessToken);

  for (const solve of solves) {
    if (!session.knownSolves.has(solve.challenge_id)) {
      session.knownSolves.add(solve.challenge_id);

      // Only send notification if not already notified
      if (!session.notifiedSolves.has(solve.challenge_id)) {
        // Fetch current rank and event name
        const { rank, totalTeams } = await fetchTeamRank(
          session.ctfdUrl,
          session.teamId,
          session.accessToken
        );
        const eventName = await fetchEventName(session.ctfdUrl, session.accessToken);

        // Calculate current total points (including this new solve)
        const currentPoints = solves.reduce((sum, solve) => sum + solve.challenge.value, 0);

        // Send notification
        const message = formatSolveNotification(
          eventName,
          session.teamName,
          solve.challenge.name,
          solve.challenge.category,
          solve.challenge.value,
          rank,
          totalTeams,
          solve.user.name,
          currentPoints
        );

        await bot.sendMessage(chatId, message, { parse_mode: "MarkdownV2" });
        
        // Mark as notified and save to file
        session.notifiedSolves.add(solve.challenge_id);
        saveActiveSessions();
      }
    }
  }
}

// Send summary and stop tracking
async function sendSummary(chatId: number, bot: TelegramBot): Promise<void> {
  const session = activeSessions.get(chatId);
  if (!session || session.teamId === null) return;

  const solves = await fetchTeamSolves(session.ctfdUrl, session.teamId, session.accessToken);
  const { rank, totalTeams } = await fetchTeamRank(session.ctfdUrl, session.teamId, session.accessToken);
  const eventName = await fetchEventName(session.ctfdUrl, session.accessToken);

  const totalPoints = solves.reduce((sum, solve) => sum + solve.challenge.value, 0);

  const message = formatSummary(
    eventName,
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
  saveActiveSessions();
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
    notifiedSolves: new Set(),
    pollInterval: null,
    summaryTimeout: null,
    endTime,
    totalChallenges,
  };

  activeSessions.set(chatId, session);
  saveActiveSessions();

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

// Restore sessions from file on startup
export async function restoreCtfdSessions(bot: TelegramBot): Promise<void> {
  const sessions = loadPersistedSessions();
  const now = new Date();

  for (const persisted of sessions) {
    const endTime = new Date(persisted.endTime);
    
    // Skip if already ended
    if (endTime <= now) {
      console.log(`Skipping expired CTFd session for chat ${persisted.chatId}`);
      continue;
    }

    console.log(`Restoring CTFd session for chat ${persisted.chatId}, team "${persisted.teamName}"`);
    
    const session: TrackingSession = {
      chatId: persisted.chatId,
      ctfdUrl: persisted.ctfdUrl,
      teamName: persisted.teamName,
      accessToken: persisted.accessToken,
      teamId: persisted.teamId,
      knownSolves: new Set(persisted.knownSolves),
      notifiedSolves: new Set(persisted.notifiedSolves || []),
      pollInterval: null,
      summaryTimeout: null,
      endTime,
      totalChallenges: persisted.totalChallenges,
    };

    activeSessions.set(persisted.chatId, session);

    // Restart polling
    session.pollInterval = setInterval(() => {
      pollSolves(persisted.chatId, bot);
    }, 30000);

    // Reschedule summary
    const timeUntilSummary = endTime.getTime() - now.getTime() - 2 * 60 * 1000;
    if (timeUntilSummary > 0) {
      session.summaryTimeout = setTimeout(() => {
        sendSummary(persisted.chatId, bot);
      }, timeUntilSummary);
    } else {
      // Send summary immediately if less than 2 minutes left
      await sendSummary(persisted.chatId, bot);
    }
  }
}

// Find easy challenges (unsolved by team, sorted by total solves)
export async function findEasyChallenges(
  ctfdUrl: string,
  teamName: string,
  accessToken: string
): Promise<string> {
  try {
    // Find team by name
    const team = await findTeamByName(ctfdUrl, teamName, accessToken);
    if (!team) {
      return `Error: Team "${teamName}" not found`;
    }

    // Fetch team solves
    const teamSolves = await fetchTeamSolves(ctfdUrl, team.id, accessToken);
    const solvedChallengeIds = new Set(teamSolves.map((s) => s.challenge_id));

    // Fetch all challenges
    const challengesUrl = `${ctfdUrl}/api/v1/challenges`;
    const response = await fetch(challengesUrl, {
      headers: {
        Authorization: `Token ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return `Error: Failed to fetch challenges (${response.status})`;
    }

    const data = await response.json() as { success: boolean; data: CTFdChallenge[] };
    if (!data.success || !data.data) {
      return "Error: Invalid challenges response";
    }

    // Filter unsolved challenges
    const unsolvedChallenges = data.data.filter((c) => !solvedChallengeIds.has(c.id));

    if (unsolvedChallenges.length === 0) {
      return "🎉 All challenges solved! Great work!";
    }

    // Fetch solve count for each unsolved challenge
    const challengesWithSolves: Array<CTFdChallenge & { solves: number }> = [];
    for (const challenge of unsolvedChallenges) {
      const solvesUrl = `${ctfdUrl}/api/v1/challenges/${challenge.id}/solves`;
      const solvesResponse = await fetch(solvesUrl, {
        headers: {
          Authorization: `Token ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (solvesResponse.ok) {
        const solvesData = await solvesResponse.json() as { success: boolean; data: unknown[] };
        const solveCount = solvesData.success && Array.isArray(solvesData.data) ? solvesData.data.length : 0;
        challengesWithSolves.push({ ...challenge, solves: solveCount });
      } else {
        challengesWithSolves.push({ ...challenge, solves: 0 });
      }
    }

    // Sort by solves descending (most solved first = easiest)
    challengesWithSolves.sort((a, b) => b.solves - a.solves);

    // Format message
    const challengeLines = challengesWithSolves.map((c) => 
      `Chall name: *${escapeMarkdownV2(c.name)}*
Category: *${escapeMarkdownV2(c.category)}*
Current points: *${c.value}*
Total solves: *${c.solves}* teams`
    ).join("\n\n");

    return `*LIST \\(MAYBE\\) EASY CHALL*

${challengeLines}`;
  } catch (error) {
    console.error("Error finding easy challenges:", error);
    return "Error: Failed to find easy challenges";
  }
}
