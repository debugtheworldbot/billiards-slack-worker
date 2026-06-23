type Env = {
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ID: string;
  SLACK_SIGNING_SECRET?: string;
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

type AppState = {
  players?: Player[];
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

type IdempotencyReserveResponse = {
  reserved: boolean;
  reason?: string;
};

type BattleReport = {
  matchCount: number;
  message: string;
};

type ParsedMatchCommand = {
  winner: string;
  loser: string;
};

const RESERVATION_CRON = "0 9 * * 2-6";
const BATTLE_REPORT_CRON = "30 11 * * 2-6";

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

const PLAYER_ALIASES: Record<string, string> = {
  chenwenjun: "cwj",
  gejunjie: "gjj",
  kuangjungang: "kznb",
  kuangzi: "kznb",
  liyu: "lybb",
  pipizhu: "ppz",
  shenxinyu: "Sinyu",
  tianchengzhuang: "ppz",
  wangruizhi: "rz",
  wuhaobing: "Hb",
  xiongjiale: "jiale",
};

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(controller.cron, env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
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

    if (url.pathname === "/slack/record-match") {
      return handleSlackRecordMatch(request, env, ctx);
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
  const report = await fetchBattleReport(env, shanghaiDateString());

  if (options.skipEmpty && report.matchCount === 0) {
    console.log("No matches today; skipped battle report.");
    return { skipped: true, matchCount: report.matchCount };
  }

  return options.idempotencyKey
    ? postToSlackOnce(env, options.idempotencyKey, report.message)
    : postToSlack(env, report.message);
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

async function fetchBattleReport(env: Env, dateSeed: string): Promise<BattleReport> {
  const url = new URL("/api/slack/battle-report", env.STATE_URL);
  url.searchParams.set("date", dateSeed);

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "billiards-slack-notifier/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }

  const report = await response.json<BattleReport>();
  if (typeof report.message !== "string" || typeof report.matchCount !== "number") {
    throw new Error(`GET ${url} returned invalid battle report`);
  }

  return { ...report, message: mentionPlayerNames(report.message) };
}

async function handleSlackRecordMatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  if (request.method !== "POST") {
    return textResponse("Method not allowed", 405);
  }

  const body = await request.text();
  if (!(await verifySlackRequest(request, env, body))) {
    return textResponse("Unauthorized", 401);
  }

  const form = new URLSearchParams(body);
  const text = form.get("text")?.trim() || "";
  const responseUrl = form.get("response_url") || "";
  const channelId = form.get("channel_id") || "";
  const recorder = formatSlackRecorder(
    form.get("user_id") || "",
    form.get("user_name") || "",
  );

  if (channelId !== env.SLACK_CHANNEL_ID) {
    return textResponse("这个命令只能在指定台球频道使用。");
  }

  ctx.waitUntil(sendSlackRecordMatchResult(env, text, responseUrl, recorder));
  return textResponse("正在记录比赛，稍后返回结果。");
}

async function sendSlackRecordMatchResult(
  env: Env,
  text: string,
  responseUrl: string,
  recorder: string,
) {
  let message: string;
  try {
    const result = await recordMatchFromSlackText(env, text);
    message = `已记录：${result.winnerName} 胜 ${result.loserName}`;
    try {
      await postToSlack(
        env,
        `*比赛记录成功*\n记录人：${recorder}\n结果：${formatPlayerName(
          result.winnerName,
        )} 胜 ${formatPlayerName(result.loserName)}`,
      );
    } catch (error) {
      console.log(
        `Match recorded but Slack channel post failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      message = `${message}，但频道消息发送失败。`;
    }
  } catch (error) {
    message = `记录失败：${error instanceof Error ? error.message : String(error)}`;
  }

  if (!responseUrl) {
    console.log(message);
    return;
  }

  await postSlackCommandResponse(responseUrl, message);
}

function formatSlackRecorder(userId: string, userName: string) {
  if (userId) return `<@${userId}>`;
  return userName ? `@${userName}` : "未知用户";
}

async function recordMatchFromSlackText(env: Env, text: string) {
  const { winner, loser } = parseMatchCommand(text);
  const state = await fetchState(env);
  const winnerPlayer = resolvePlayer(state.players || [], winner);
  const loserPlayer = resolvePlayer(state.players || [], loser);

  if (winnerPlayer.id === loserPlayer.id) {
    throw new Error("胜者和败者不能是同一个人。");
  }

  await createMatch(env, winnerPlayer.id, loserPlayer.id);
  return {
    winnerName: winnerPlayer.name,
    loserName: loserPlayer.name,
  };
}

function parseMatchCommand(text: string): ParsedMatchCommand {
  const tokens = text
    .replace(/[，,]/g, " ")
    .replace(/\b(?:beat|beats|defeated|defeats|vs|v)\b/gi, " ")
    .replace(/[胜赢]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length !== 2) {
    throw new Error("用法：/record-match 胜者 败者，例如 /record-match cwj gjj。");
  }

  return { winner: tokens[0], loser: tokens[1] };
}

function resolvePlayer(players: Player[], token: string): Player {
  const slackMention = token.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/);
  const playerName = slackMention
    ? Object.entries(PLAYER_SLACK_MENTIONS).find(
        ([, userId]) => userId === slackMention[1],
      )?.[0]
    : token.replace(/^@/, "");
  const normalizedName = playerName
    ? PLAYER_ALIASES[playerName.toLowerCase()] || playerName.toLowerCase()
    : undefined;
  const matches = players.filter(
    (player) => player.name.toLowerCase() === normalizedName,
  );

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`选手名不唯一：${playerName}`);
  throw new Error(`找不到选手：${token}`);
}

async function createMatch(env: Env, winnerId: string, loserId: string) {
  const url = new URL("/api/matches", env.STATE_URL);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "billiards-slack-notifier/1.0",
    },
    body: JSON.stringify({
      winnerId,
      loserId,
      winnerMoments: [],
      loserMoments: [],
      winnerNote: "",
      loserNote: "",
    }),
  });

  if (!response.ok) {
    throw new Error(`POST ${url} failed: HTTP ${response.status}`);
  }
}

async function postSlackCommandResponse(responseUrl: string, message: string) {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      response_type: "ephemeral",
      text: message,
    }),
  });

  if (!response.ok) {
    throw new Error(`Slack response_url failed: HTTP ${response.status}`);
  }
}

async function verifySlackRequest(request: Request, env: Env, body: string) {
  if (!env.SLACK_SIGNING_SECRET) return false;

  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const requestAgeSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(requestAgeSeconds) || requestAgeSeconds > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${body}`),
  );
  const expected = `v0=${hex(new Uint8Array(digest))}`;

  return timingSafeEqual(expected, request.headers.get("x-slack-signature") || "");
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

function mentionPlayerNames(message: string) {
  return Object.keys(PLAYER_SLACK_MENTIONS)
    .sort((left, right) => right.length - left.length)
    .reduce((text, name) => {
      const pattern = new RegExp(
        `(^|[^A-Za-z0-9_@])(${escapeRegExp(name)})(?=$|[^A-Za-z0-9_])`,
        "g",
      );
      return text.replace(pattern, `$1${formatPlayerName(name)}`);
    }, message);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shanghaiDateString(date = new Date()) {
  return formatDateInTimeZone(date, "Asia/Shanghai");
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

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }

  return diff === 0;
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

function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
