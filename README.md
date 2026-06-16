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

## Deploy

```bash
npm install
npx wrangler deploy
```
