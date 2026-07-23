# traffic_check (`tc`)

Daily commute traffic check. Queries the **Google Maps Routes API** for live-traffic
travel time on a fixed route, compares it to the free-flow baseline, and posts a
one-line summary to a **Slack channel** via an incoming webhook.

Example Slack message:

> 🟡 Evening commute — 23 min now vs 18 min normal (+5 min, moderate). 7.4 km.

Color/level: 🟢 light (`< 10%` over baseline), 🟡 moderate (`10–30%`), 🔴 heavy (`> 30%`).

## Setup

### 1. Google Maps API key

1. Create (or pick) a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. **Enable billing** on the project (a card is required even though one check/day stays
   within the free tier).
3. Enable the **Routes API** (APIs & Services → Library → "Routes API" → Enable).
4. Create an API key (APIs & Services → Credentials → Create credentials → API key).
   Recommended: restrict the key to the **Routes API** only.

### 2. Slack incoming webhook

1. Go to <https://api.slack.com/apps> → Create New App → From scratch.
2. Enable **Incoming Webhooks**, add a new webhook, and pick the channel to post to
   (a private personal channel works well).
3. Copy the webhook URL (`https://hooks.slack.com/services/...`).

### 3. Config file

Create `~/.config/orion/traffic_check.json` (kept outside the repo so secrets are never
committed). Use `traffic_check.example.json` as a template:

```bash
mkdir -p ~/.config/orion
cp traffic_check.example.json ~/.config/orion/traffic_check.json
chmod 600 ~/.config/orion/traffic_check.json
# then edit it with your key, webhook URL, and addresses
```

Fields: `googleMapsApiKey`, `slackWebhookUrl`, `origin`, `destination`, `label`.
`origin` and `destination` accept either a street address or a `"lat, lng"`
coordinate string (e.g. `"42.656545, 21.150597"`).

You can override any field with env vars for quick testing:
`GOOGLE_MAPS_API_KEY`, `SLACK_WEBHOOK_URL`, `TRAFFIC_ORIGIN`, `TRAFFIC_DESTINATION`, `TRAFFIC_LABEL`.

### 4. Test it

```bash
./tc
```

You should see the formatted line printed and a message arrive in your Slack channel.

### 5. Schedule it (weekdays at 16:30)

```bash
crontab -e
```

Add:

```
30 16 * * 1-5 /Users/bleron.qorri/Desktop/repos/orion/scripts/traffic_check/tc >> /tmp/traffic_check.log 2>&1
```

Adjust `30 16` for a different time within the 4–5 PM window (e.g. `00 17` for 5 PM).

**macOS notes:**
- The Mac must be **awake** at the scheduled time for cron to fire.
- `cron` may need **Full Disk Access** (System Settings → Privacy & Security → Full Disk
  Access → add `/usr/sbin/cron`).
- If cron proves flaky on a laptop that sleeps, a **launchd LaunchAgent** is the
  macOS-native alternative and handles sleep/missed runs better — ask and I'll add one.
