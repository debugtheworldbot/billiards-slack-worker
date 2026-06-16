type Env = {
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ID: string;
  STATE_URL: string;
  ADMIN_TOKEN?: string;
  IDEMPOTENCY: DurableObjectNamespace;
};

type Player = {
  id: string;
  name: string;
  createdAt: string;
  isActive: boolean;
};

type MatchRecord = {
  id: string;
  winnerId: string;
  loserId: string;
  createdAt: string;
  winnerMoments?: string[];
  loserMoments?: string[];
  winnerNote?: string;
  loserNote?: string;
};

type AppState = {
  players: Player[];
  matches: MatchRecord[];
  settings?: {
    kFactor?: number;
  };
};

type ReservationEntry = {
  order: number;
  id: string;
  name: string;
  createdAt: string;
  drawNumber: number;
  drawNumberLabel: string;
  dateSeed: string;
  drawSeed: string;
};

type TimelineEntry = MatchRecord & {
  winnerName: string;
  loserName: string;
  winnerDelta: number;
  loserDelta: number;
  winnerRatingAfter: number;
  loserRatingAfter: number;
};

type IdempotencyReserveResponse = {
  reserved: boolean;
  reason?: string;
};

const RESERVATION_CRON = "0 9 * * 2-6";
const BATTLE_REPORT_CRON = "30 11 * * 2-6";
const DEFAULT_RATING = 1000;
const DEFAULT_K_FACTOR = 100;
const NEW_PLAYER_K_FACTOR = 150;
const STABLE_PLAYER_K_FACTOR = 50;
const NEW_PLAYER_GAME_THRESHOLD = 10;
const STABLE_PLAYER_GAME_THRESHOLD = 30;

const SPECIAL_DATE_SEEDS: Record<string, string> = {
  "2026-06-01": "reset-6",
};

const PLAYER_SLACK_MENTIONS: Record<string, string> = {
  cwj: "U02KGJZPZ19",
  gjj: "U05PAT2JS7Q",
  haoqing: "U08VATT3Z6E",
  Hb: "U06C7R0J49G",
  jiale: "U09A9LMK1UG",
  kznb: "U075KFYE68Z",
  lybb: "U045V1TBJ1J",
  ppz: "U02DG5JM4DQ",
  rz: "U07RP73DWJE",
  Sinyu: "UL46YT8LA",
};

const MOMENT_LABELS: Record<string, string> = {
  clearance_runout: "一杆清台",
  shutout: "零封对手",
  win_by_3: "胜对手3球",
  win_by_5: "胜对手5球",
  comeback_win: "逆转翻盘",
  hill_hill_finish: "决胜局绝杀",
  scratch_black_8: "误进黑八",
  double_scratch: "连续白球失误",
  hill_hill_meltdown: "决胜局断电",
};

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(controller.cron, env));
  },

  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "billiards-slack-notifier",
        crons: {
          reservation: RESERVATION_CRON,
          battleReport: BATTLE_REPORT_CRON,
        },
      });
    }

    if (url.pathname === "/send/reservation") {
      assertAuthorized(request, env);
      const message = await buildReservationMessage(env);
      const result = await postToSlack(env, message);
      return jsonResponse({ ok: true, type: "reservation", result });
    }

    if (url.pathname === "/send/battle-report") {
      assertAuthorized(request, env);
      const result = await sendBattleReport(env, { skipEmpty: false });
      return jsonResponse({ ok: true, type: "battle-report", result });
    }

    return jsonResponse({ ok: false, error: "not_found" }, 404);
  },
};

export class IdempotencyGate {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/reserve") {
      const now = Date.now();
      const pendingTimeoutMs = 15 * 60 * 1000;
      const result = await this.state.storage.transaction(async (transaction) => {
        const existing = await transaction.get<{
          status: "pending" | "sent";
          updatedAt: number;
        }>("status");

        if (existing?.status === "sent") {
          return { reserved: false, reason: "already_sent" };
        }

        if (
          existing?.status === "pending" &&
          now - existing.updatedAt < pendingTimeoutMs
        ) {
          return { reserved: false, reason: "already_pending" };
        }

        await transaction.put("status", { status: "pending", updatedAt: now });
        return { reserved: true };
      });

      return jsonResponse(result);
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      await this.state.storage.put("status", {
        status: "sent",
        updatedAt: Date.now(),
      });
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/release") {
      await this.state.storage.delete("status");
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }
}

async function handleScheduled(cron: string, env: Env) {
  if (cron === RESERVATION_CRON) {
    const dateSeed = shanghaiDateString();
    const message = await buildReservationMessage(env, dateSeed);
    await postToSlackOnce(env, `reservation:${dateSeed}`, message);
    return;
  }

  if (cron === BATTLE_REPORT_CRON) {
    await sendBattleReport(env, {
      skipEmpty: true,
      idempotencyKey: `battle-report:${shanghaiDateString()}`,
    });
    return;
  }

  console.log(`Unknown cron: ${cron}`);
}

async function sendBattleReport(
  env: Env,
  options: { skipEmpty: boolean; idempotencyKey?: string },
) {
  const state = await fetchState(env);
  const { message, matchCount } = buildBattleReportMessage(state, shanghaiDateString());

  if (options.skipEmpty && matchCount === 0) {
    console.log("No matches today; skipped battle report.");
    return { skipped: true, matchCount };
  }

  return options.idempotencyKey
    ? postToSlackOnce(env, options.idempotencyKey, message)
    : postToSlack(env, message);
}

async function buildReservationMessage(env: Env, dateSeed = shanghaiDateString()) {
  const state = await fetchState(env);
  const entries = buildReservationOrder(state.players || [], dateSeed);

  return [
    `*今日台球预约每日排序（${dateSeed}）*`,
    `参与球员：${entries.length} 人`,
    "",
    ...entries.map(
      (entry) =>
        `${entry.order}. ${formatPlayerName(entry.name)} \`${entry.drawNumberLabel}\``,
    ),
  ].join("\n");
}

async function postToSlackOnce(env: Env, key: string, message: string) {
  const gate = env.IDEMPOTENCY.get(env.IDEMPOTENCY.idFromName(key));
  const reserve = await gate.fetch("https://idempotency.local/reserve", {
    method: "POST",
  });
  const reserveData = await reserve.json<IdempotencyReserveResponse>();

  if (!reserveData.reserved) {
    console.log(`Skipped duplicate Slack post for ${key}: ${reserveData.reason}`);
    return { skipped: true, key, reason: reserveData.reason };
  }

  try {
    const result = await postToSlack(env, message);
    await gate.fetch("https://idempotency.local/complete", { method: "POST" });
    return result;
  } catch (error) {
    await gate.fetch("https://idempotency.local/release", { method: "POST" });
    throw error;
  }
}

async function fetchState(env: Env): Promise<AppState> {
  const response = await fetch(env.STATE_URL, {
    headers: {
      accept: "application/json",
      "user-agent": "billiards-slack-notifier/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`GET ${env.STATE_URL} failed: HTTP ${response.status}`);
  }

  return response.json();
}

function buildReservationOrder(players: Player[], dateSeed: string): ReservationEntry[] {
  const drawSeed = SPECIAL_DATE_SEEDS[dateSeed]
    ? `${dateSeed}|${SPECIAL_DATE_SEEDS[dateSeed]}`
    : dateSeed;

  return players
    .filter((player) => player.isActive)
    .map((player) => {
      const hashInput = `${drawSeed}|${player.id}|${player.name}|${player.createdAt}`;
      const drawNumber = fnv1a32(hashInput);
      return {
        order: 0,
        id: player.id,
        name: player.name,
        createdAt: player.createdAt,
        drawNumber,
        drawNumberLabel: drawNumber.toString(16).toUpperCase().padStart(8, "0"),
        dateSeed,
        drawSeed,
      };
    })
    .sort((left, right) => {
      if (left.drawNumber !== right.drawNumber) return left.drawNumber - right.drawNumber;
      const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
      if (createdAtOrder !== 0) return createdAtOrder;
      return left.id.localeCompare(right.id);
    })
    .map((entry, index) => ({ ...entry, order: index + 1 }));
}

function buildBattleReportMessage(
  state: AppState,
  dateSeed: string,
): { message: string; matchCount: number } {
  const { start, end } = shanghaiDateBounds(dateSeed);
  const timeline = buildMatchTimeline(state.players || [], state.matches || []);
  const todayMatches = timeline.filter((match) => {
    const createdAt = new Date(match.createdAt);
    return createdAt >= start && createdAt < end;
  });

  const records = new Map(
    (state.players || []).map((player) => [
      player.name,
      { name: player.name, wins: 0, losses: 0, delta: 0 },
    ]),
  );

  for (const match of todayMatches) {
    const winner = records.get(match.winnerName);
    const loser = records.get(match.loserName);
    if (winner) {
      winner.wins += 1;
      winner.delta += match.winnerDelta;
    }
    if (loser) {
      loser.losses += 1;
      loser.delta += match.loserDelta;
    }
  }

  const activeRecords = [...records.values()]
    .filter((record) => record.wins || record.losses)
    .sort(
      (left, right) =>
        right.wins - left.wins ||
        right.delta - left.delta ||
        left.losses - right.losses ||
        left.name.localeCompare(right.name),
    );

  const lines = [`*今日战报（${dateSeed}）*`, `今日共 ${todayMatches.length} 场`];

  if (!todayMatches.length) {
    lines.push("今天还没有录入比赛。");
    return { message: lines.join("\n"), matchCount: todayMatches.length };
  }

  lines.push("", "*逐场结果*");
  todayMatches.forEach((match, index) => {
    lines.push(
      `${index + 1}. ${timeLabel(match.createdAt)} ${formatPlayerName(
        match.winnerName,
      )} 胜 ${formatPlayerName(match.loserName)} ` +
        `（${signed(match.winnerDelta)} / ${signed(match.loserDelta)}）` +
        `${momentsText(match)}`,
    );
  });

  lines.push("", "*今日胜负榜*");
  activeRecords.forEach((record, index) => {
    lines.push(
      `${index + 1}. ${formatPlayerName(record.name)} ${record.wins}胜${
        record.losses
      }负，净积分 ${signed(record.delta)}`,
    );
  });

  return { message: lines.join("\n"), matchCount: todayMatches.length };
}

function buildMatchTimeline(players: Player[], matches: MatchRecord[]): TimelineEntry[] {
  let stats = createInitialStats(players);
  let activeMonthKey = "";
  const playerMap = Object.fromEntries(players.map((player) => [player.id, player]));

  return [...matches]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((match) => {
      const key = localMonthKey(match.createdAt);

      if (key !== activeMonthKey) {
        stats = createInitialStats(players);
        activeMonthKey = key;
      }

      const winner = stats[match.winnerId];
      const loser = stats[match.loserId];
      const winnerPlayer = playerMap[match.winnerId];
      const loserPlayer = playerMap[match.loserId];
      if (!winner || !loser || !winnerPlayer || !loserPlayer) return null;

      const winnerKFactor = getEffectiveKFactor(winner.wins + winner.losses);
      const loserKFactor = getEffectiveKFactor(loser.wins + loser.losses);
      const delta = calculateMatchDelta(
        winner.rating,
        loser.rating,
        winnerKFactor,
        loserKFactor,
      );
      const entry: TimelineEntry = {
        ...match,
        winnerName: winnerPlayer.name,
        loserName: loserPlayer.name,
        winnerDelta: delta.winnerDelta,
        loserDelta: delta.loserDelta,
        winnerRatingAfter: winner.rating + delta.winnerDelta,
        loserRatingAfter: loser.rating + delta.loserDelta,
      };

      winner.rating += delta.winnerDelta;
      winner.wins += 1;
      loser.rating += delta.loserDelta;
      loser.losses += 1;

      return entry;
    })
    .filter((entry): entry is TimelineEntry => Boolean(entry));
}

function createInitialStats(players: Player[]) {
  return Object.fromEntries(
    players.map((player) => [
      player.id,
      {
        rating: DEFAULT_RATING,
        wins: 0,
        losses: 0,
      },
    ]),
  );
}

function getEffectiveKFactor(totalMatchesBefore: number) {
  if (totalMatchesBefore < NEW_PLAYER_GAME_THRESHOLD) return NEW_PLAYER_K_FACTOR;
  if (totalMatchesBefore >= STABLE_PLAYER_GAME_THRESHOLD) return STABLE_PLAYER_K_FACTOR;
  return DEFAULT_K_FACTOR;
}

function calculateMatchDelta(
  winnerRating: number,
  loserRating: number,
  winnerKFactor: number,
  loserKFactor: number,
) {
  return {
    winnerDelta: calculatePlayerDelta({
      playerRating: winnerRating,
      opponentRating: loserRating,
      playerKFactor: winnerKFactor,
      actualScore: 1,
    }),
    loserDelta: calculatePlayerDelta({
      playerRating: loserRating,
      opponentRating: winnerRating,
      playerKFactor: loserKFactor,
      actualScore: 0,
    }),
  };
}

function calculatePlayerDelta({
  playerRating,
  opponentRating,
  playerKFactor,
  actualScore,
}: {
  playerRating: number;
  opponentRating: number;
  playerKFactor: number;
  actualScore: 0 | 1;
}) {
  const expectedScore = 1 / (1 + 10 ** ((opponentRating - playerRating) / 400));
  const multiplier =
    actualScore === 0 ? getLossPenaltyMultiplier(playerRating, opponentRating) : 1;
  const rawDelta = playerKFactor * (actualScore - expectedScore) * multiplier;
  return rawDelta < 0 ? -Math.round(Math.abs(rawDelta)) : Math.round(rawDelta);
}

function getLossPenaltyMultiplier(loserRating: number, winnerRating: number) {
  const gap = loserRating - winnerRating;
  const sigmoid = 1 / (1 + Math.exp(-gap / 400));
  return 0.1 + sigmoid * 0.8;
}

function fnv1a32(input: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x1000193);
  }
  return hash >>> 0;
}

function formatPlayerName(name: string) {
  const userId = PLAYER_SLACK_MENTIONS[name];
  return userId ? `${name} <@${userId}>` : name;
}

function signed(delta: number) {
  return delta > 0 ? `+${delta}` : String(delta);
}

function momentsText(match: TimelineEntry) {
  const bits = [];
  for (const key of match.winnerMoments || []) {
    bits.push(`${match.winnerName}：${MOMENT_LABELS[key] || key}`);
  }
  for (const key of match.loserMoments || []) {
    bits.push(`${match.loserName}：${MOMENT_LABELS[key] || key}`);
  }
  return bits.length ? `（${bits.join("；")}）` : "";
}

function shanghaiDateString(date = new Date()) {
  return formatDateInTimeZone(date, "Asia/Shanghai");
}

function shanghaiDateBounds(dateSeed: string) {
  const [year, month, day] = dateSeed.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, day - 1, 16, 0, 0, 0)),
    end: new Date(Date.UTC(year, month - 1, day, 16, 0, 0, 0)),
  };
}

function localMonthKey(isoString: string) {
  return formatDateInTimeZone(new Date(isoString), "Asia/Shanghai").slice(0, 7);
}

function formatDateInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timeLabel(isoString: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoString));
}

async function postToSlack(env: Env, message: string) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: env.SLACK_CHANNEL_ID,
      text: message,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const data = await response.json<{
    ok: boolean;
    error?: string;
    channel?: string;
    ts?: string;
  }>();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Slack chat.postMessage failed: HTTP ${response.status} ${JSON.stringify(
        data,
      )}`,
    );
  }

  return { channel: data.channel, ts: data.ts };
}

function assertAuthorized(request: Request, env: Env) {
  if (!env.ADMIN_TOKEN) {
    throw new Response("ADMIN_TOKEN is not configured", { status: 403 });
  }

  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (token !== env.ADMIN_TOKEN) {
    throw new Response("Unauthorized", { status: 401 });
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
