# Billiards Slack Worker

Cloudflare Worker version of the billiards Slack notifier.

Deployed Worker:

```text
https://billiards-slack-notifier.istiancz.workers.dev
```

## Schedule

Cloudflare cron is UTC:

- `0 9 * * 2-6`: weekdays 17:00 Asia/Shanghai, sends reservation order.
- `30 11 * * 2-6`: weekdays 19:30 Asia/Shanghai, sends battle report only when today's matches exist.

Cloudflare uses `1 = Sunday` and `7 = Saturday` for the weekday field, so
Monday through Friday is `2-6`.

## Secrets

Required:

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
```

Optional but recommended for manual test endpoints:

```bash
npx wrangler secret put ADMIN_TOKEN
```

The current deployment has both secrets configured. A copy of `ADMIN_TOKEN` is
stored in macOS Keychain under service:

```text
billiards-slack-worker-admin-token
```

## Manual Test

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://billiards-slack-notifier.<subdomain>.workers.dev/send/reservation

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://billiards-slack-notifier.<subdomain>.workers.dev/send/battle-report
```

For the current deployment:

```bash
ADMIN_TOKEN="$(security find-generic-password -a "$USER" -s billiards-slack-worker-admin-token -w)"

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://billiards-slack-notifier.istiancz.workers.dev/send/reservation

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://billiards-slack-notifier.istiancz.workers.dev/send/battle-report
```

The old local launchd jobs have been unloaded to avoid duplicate Slack posts.

## Slack Match Recording

Create a Slack slash command pointing to:

```text
https://billiards-slack-notifier.istiancz.workers.dev/slack/record-match
```

Use it as:

```text
/record-match cwj gjj
/record-match cwj 胜 gjj
```

The first player is recorded as winner and the second as loser. The Worker
verifies Slack's request signature, resolves player names from `/api/state`,
then writes the match to `/api/matches` with empty moments and notes.
The command only works in the configured `SLACK_CHANNEL_ID`.

## Idempotency

Scheduled sends are guarded by a Durable Object:

- `reservation:YYYY-MM-DD`
- `battle-report:YYYY-MM-DD`

If Cloudflare invokes the same cron more than once, the second invocation skips
the Slack post. Manual `/send/...` endpoints intentionally bypass this guard so
they can still be used for testing.

## Deploy

```bash
npm install
npx wrangler deploy
```
