# Telegram Daily Summary App

Scrapes messages from a Telegram group and posts a summary twice daily:
- 3:30 PM IST
- 8:00 PM IST

It supports:
- Daily message summary for the current IST day
- Optional sender whitelist (`includeSenders`) with default `all`
- Optional message highlights via env `INCLUDE_MESSAGE_HIGHLIGHTS` (default `false`)
- Message links where Telegram can resolve them
- Optional AI summary using Gemini API

## 1) Install

```bash
cd /Users/I565138/Documents/Learning/telegram-daily-summary
npm install
```

## 2) Configure

```bash
cp .env.example .env
```

Set required values in `.env`:
- `API_ID`
- `API_HASH`
- `GROUP_ID_OR_USERNAME` (`@groupname` or group id like `-100...`)

Optional AI summary values:
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (default `gemini-2.0-flash`)
- `AI_MIN_MESSAGES_FOR_SUMMARY` (default `10`)
- `AI_MAX_MESSAGES_FOR_SUMMARY` (default `100`)
- `AI_MAX_CHARS_PER_MESSAGE` (default `400`)
- `TELEGRAM_MESSAGE_MAX_CHARS` (default `3900`, used to split long summaries across multiple Telegram messages)
- `INCLUDE_MESSAGE_HIGHLIGHTS` (default `false`; accepts `true/false`, `1/0`, `yes/no`, `on/off`)

Optional scheduler values:
- `CRON_TIMEZONE` (default `Asia/Kolkata`)
- `SUMMARY_CRON_NO_AI` (default `0 30 15 * * *`)
- `SUMMARY_CRON_WITH_AI` (default `0 0 20 * * *`)

### Create `STRING_SESSION`

```bash
npm run init-session
```

After login, copy printed value into `.env` as `STRING_SESSION`.

## 3) Optional Sender Filter

Edit `config/summary-config.json`.

Default:
```json
{
  "includeSenders": [],
  "includeMessageHighlights": false
}
```

Examples:
```json
{
  "includeSenders": ["@alice", "Bob Singh", "123456789"],
  "includeMessageHighlights": true
}
```

Matching is exact against sender `@username`, full name, or sender id.
Message highlights are included in the Telegram summary only when `INCLUDE_MESSAGE_HIGHLIGHTS=true`.
`includeMessageHighlights` in `config/summary-config.json` is still supported as a fallback when the env var is not set.

## 4) Run

Run scheduler:
```bash
npm start
```
AI summary runs only on the 8:00 PM IST scheduled run by default.
You can change schedule timings through `SUMMARY_CRON_NO_AI`, `SUMMARY_CRON_WITH_AI`, and `CRON_TIMEZONE`.

Run immediate one-off summary:
```bash
npm run run-once
```

## Output

- Sends summary to `SUMMARY_TARGET` targets (comma-separated, default `me`)
- Saves a local copy under `output/`

## Notes

- For private groups, links usually use `https://t.me/c/<groupId>/<messageId>`.
- For public groups/channels, links usually use `https://t.me/<username>/<messageId>`.
- If Gemini env vars are not set, app still runs with non-AI summary.
