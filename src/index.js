import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import input from 'input';
import { fileURLToPath } from 'node:url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'config', 'summary-config.json');

const requiredEnv = ['API_ID', 'API_HASH', 'GROUP_ID_OR_USERNAME'];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill required values.');
  process.exit(1);
}

const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const GROUP_ID_OR_USERNAME = process.env.GROUP_ID_OR_USERNAME;
const STRING_SESSION = process.env.STRING_SESSION ?? '';
const SUMMARY_TARGET = process.env.SUMMARY_TARGET || 'me';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const MAX_MESSAGES_PER_RUN = Number(process.env.MAX_MESSAGES_PER_RUN || 3000);
const AI_MIN_MESSAGES_FOR_SUMMARY = Number(process.env.AI_MIN_MESSAGES_FOR_SUMMARY || 3);
const AI_MAX_MESSAGES_FOR_SUMMARY = Number(process.env.AI_MAX_MESSAGES_FOR_SUMMARY || 100);
const AI_MAX_CHARS_PER_MESSAGE = Number(process.env.AI_MAX_CHARS_PER_MESSAGE || 400);
const TELEGRAM_MESSAGE_MAX_CHARS = Number(process.env.TELEGRAM_MESSAGE_MAX_CHARS || 3900);
const INCLUDE_MESSAGE_HIGHLIGHTS_ENV = process.env.INCLUDE_MESSAGE_HIGHLIGHTS;
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';
const SUMMARY_CRON_NO_AI = process.env.SUMMARY_CRON_NO_AI || '0 30 15 * * *';
const SUMMARY_CRON_WITH_AI = process.env.SUMMARY_CRON_WITH_AI || '0 0 20 * * *';

const args = new Set(process.argv.slice(2));
let aiRetryAfterMs = 0;
let geminiRequestCount = 0;

function parseRetryAfterMs(response, errorText) {
  const header = response.headers.get('retry-after');
  if (header) {
    const sec = Number(header);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.round(sec * 1000);
    }
  }

  const match = errorText.match(/Please retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (match) {
    const sec = Number(match[1]);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.round(sec * 1000);
    }
  }

  return 15 * 60 * 1000;
}

function formatDuration(ms) {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function getIstDayBounds(date = new Date()) {
  const istOffsetMinutes = 330;
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const istMs = utcMs + istOffsetMinutes * 60000;
  const ist = new Date(istMs);

  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const day = ist.getUTCDate();

  const startUtcMs = Date.UTC(year, month, day, 0, 0, 0, 0) - istOffsetMinutes * 60000;
  const endUtcMs = Date.UTC(year, month, day, 23, 59, 59, 999) - istOffsetMinutes * 60000;

  return {
    startUtc: new Date(startUtcMs),
    endUtc: new Date(endUtcMs),
    labelIstDate: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}

function formatIst(date) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata'
  }).format(date);
}

function loadSummaryConfig() {
  const defaults = {
    includeSenders: [],
    includeMessageHighlights: false
  };

  if (!fs.existsSync(configPath)) {
    return defaults;
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const includeSenders = Array.isArray(config.includeSenders)
      ? config.includeSenders.map((v) => String(v).toLowerCase().trim()).filter(Boolean)
      : [];
    const includeMessageHighlights = config.includeMessageHighlights === true;
    return {
      includeSenders,
      includeMessageHighlights
    };
  } catch (err) {
    console.warn(`Could not parse config at ${configPath}: ${err.message}`);
    return defaults;
  }
}

function normalizeSender(sender) {
  const username = sender?.username ? `@${sender.username}` : '';
  const first = sender?.firstName ?? '';
  const last = sender?.lastName ?? '';
  const fullName = `${first} ${last}`.trim();
  const id = sender?.id ? String(sender.id) : '';

  return {
    username,
    fullName,
    id,
    display: username || fullName || id || 'Unknown'
  };
}

function truncate(text, limit = 180) {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseSummaryTargets(rawValue) {
  const targets = String(rawValue || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return targets.length > 0 ? targets : ['me'];
}

function splitForTelegram(message, maxChars) {
  const text = String(message || '').trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n\n', maxChars);
    if (splitAt < Math.floor(maxChars * 0.5)) {
      splitAt = remaining.lastIndexOf('\n', maxChars);
    }
    if (splitAt < Math.floor(maxChars * 0.5)) {
      splitAt = remaining.lastIndexOf(' ', maxChars);
    }
    if (splitAt <= 0) {
      splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function coerceMessageDate(rawDate) {
  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    return rawDate;
  }

  if (typeof rawDate === 'number' && Number.isFinite(rawDate)) {
    // Telegram dates are commonly unix seconds.
    const ms = rawDate < 1e12 ? rawDate * 1000 : rawDate;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof rawDate === 'string' && rawDate.trim()) {
    const parsed = new Date(rawDate);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function resolveMessageLink(groupEntity, messageId) {
  const username = groupEntity?.username;
  if (username) {
    return `https://t.me/${username}/${messageId}`;
  }

  const rawId = groupEntity?.id ? String(groupEntity.id) : '';
  if (!rawId) {
    return null;
  }

  const cleanId = rawId.replace(/^-100/, '').replace(/^-/, '');
  if (!cleanId) {
    return null;
  }

  return `https://t.me/c/${cleanId}/${messageId}`;
}

async function maybeGenerateAiSummary(messages) {
  if (!GEMINI_API_KEY || messages.length === 0) {
    return null;
  }
  if (Date.now() < aiRetryAfterMs) {
    const waitMs = aiRetryAfterMs - Date.now();
    console.warn(`AI summary on cooldown after Gemini rate-limit. Retry after ${formatDuration(waitMs)}.`);
    return null;
  }

  const maxMessages = toPositiveInt(AI_MAX_MESSAGES_FOR_SUMMARY, 100);
  const maxChars = toPositiveInt(AI_MAX_CHARS_PER_MESSAGE, 400);
  const payloadMessages = messages.slice(-maxMessages).map((m) => ({
    sender: m.senderDisplay,
    timeIst: formatIst(m.date),
    text: truncate(m.text, maxChars)
  }));
  geminiRequestCount += 1;
  console.log(
    `Gemini request #${geminiRequestCount}: sending ${payloadMessages.length} messages (maxCharsPerMessage=${maxChars}).`
  );

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: 'You summarize Telegram group messages. Return concise plain text with key topics, decisions, asks, and blockers.'
            }
          ]
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Create a daily summary from these messages: ${JSON.stringify(payloadMessages)}`
              }
            ]
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 429) {
      const retryMs = parseRetryAfterMs(response, errorText);
      aiRetryAfterMs = Date.now() + retryMs;
      console.warn(`Gemini quota/rate limit hit (429). AI summary paused for ${formatDuration(retryMs)}.`);
      return null;
    }
    throw new Error(`Gemini API failed (${response.status}): ${errorText}`);
  }

  const json = await response.json();
  const usage = json?.usageMetadata || {};
  const promptTokens = usage.promptTokenCount ?? 'n/a';
  const outputTokens = usage.candidatesTokenCount ?? 'n/a';
  const totalTokens = usage.totalTokenCount ?? 'n/a';
  console.log(
    `Gemini response #${geminiRequestCount}: promptTokens=${promptTokens}, outputTokens=${outputTokens}, totalTokens=${totalTokens}.`
  );
  const aiText = json?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim();
  return aiText || null;
}

function buildSummaryText({
  groupTitle,
  dateLabel,
  messages,
  senderFilter,
  aiSummary,
  includeMessageHighlights = false
}) {
  const senderStats = new Map();
  for (const msg of messages) {
    senderStats.set(msg.senderDisplay, (senderStats.get(msg.senderDisplay) || 0) + 1);
  }

  const sendersSection = [...senderStats.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sender, count]) => `- ${sender}: ${count}`)
    .join('\n');

  const messageLines = messages.slice(0, 50).map((m) => {
    const time = new Intl.DateTimeFormat('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    }).format(m.date);
    const linkText = m.link ? `\n  Link: ${m.link}` : '';
    return `- [${time}] ${m.senderDisplay}: ${truncate(m.text, 220)}${linkText}`;
  });

  const filterText = senderFilter.length > 0 ? senderFilter.join(', ') : 'All senders';

  const parts = [
    `Daily Telegram Summary (${dateLabel} IST)`,
    `Group: ${groupTitle}`,
    `Sender Filter: ${filterText}`,
    `Total Messages: ${messages.length}`,
    '',
    'Message Count by Sender:',
    sendersSection || '- No messages',
    ''
  ];

  if (aiSummary) {
    parts.push('AI Summary:');
    parts.push(aiSummary.trim());
    parts.push('');
  }

  if (includeMessageHighlights) {
    parts.push('Message Highlights (up to 50):');
    parts.push(messageLines.length > 0 ? messageLines.join('\n') : '- No matching messages for this period.');
  }

  return parts.join('\n');
}

async function createClient() {
  const session = new StringSession(STRING_SESSION);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5
  });
  return client;
}

async function initializeSession() {
  const client = await createClient();
  await client.start({
    phoneNumber: async () => input.text('Phone number (+countrycode...): '),
    password: async () => input.text('2FA password (if enabled): '),
    phoneCode: async () => input.text('Telegram login code: '),
    onError: (err) => console.error(err)
  });

  console.log('\nSet this in your .env as STRING_SESSION:');
  console.log(client.session.save());
  await client.disconnect();
}

async function fetchGroupMessagesForToday(client, senderFilter) {
  const groupEntity = await client.getEntity(GROUP_ID_OR_USERNAME);
  const groupTitle = groupEntity?.title || groupEntity?.username || GROUP_ID_OR_USERNAME;
  const { startUtc, endUtc, labelIstDate } = getIstDayBounds(new Date());

  const messages = [];
  const stats = {
    scanned: 0,
    skippedMissingDate: 0,
    skippedAfterWindow: 0,
    skippedEmptyText: 0,
    skippedSenderFilter: 0,
    stoppedBeforeWindow: false
  };

  for await (const msg of client.iterMessages(groupEntity, { limit: MAX_MESSAGES_PER_RUN })) {
    stats.scanned += 1;
    const msgDate = coerceMessageDate(msg?.date);

    if (!msgDate) {
      stats.skippedMissingDate += 1;
      continue;
    }
    if (msgDate > endUtc) {
      stats.skippedAfterWindow += 1;
      continue;
    }
    if (msgDate < startUtc) {
      stats.stoppedBeforeWindow = true;
      break;
    }

    const text = (msg.message || '').trim();
    if (!text) {
      stats.skippedEmptyText += 1;
      continue;
    }

    const sender = await msg.getSender();
    const normalized = normalizeSender(sender);

    if (senderFilter.length > 0) {
      const candidates = [normalized.username, normalized.fullName, normalized.id]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      const accepted = senderFilter.some((f) => candidates.includes(f));
      if (!accepted) {
        stats.skippedSenderFilter += 1;
        continue;
      }
    }

    messages.push({
      id: msg.id,
      date: msgDate,
      text,
      senderDisplay: normalized.display,
      link: resolveMessageLink(groupEntity, msg.id)
    });
  }

  messages.sort((a, b) => a.date - b.date);

  return {
    groupTitle,
    dateLabel: labelIstDate,
    stats,
    messages
  };
}

async function runSummaryJob(client, options = {}) {
  const { enableAi = true } = options;
  const { includeSenders: senderFilter, includeMessageHighlights: includeMessageHighlightsFromConfig } =
    loadSummaryConfig();
  const includeMessageHighlights = INCLUDE_MESSAGE_HIGHLIGHTS_ENV == null
    ? includeMessageHighlightsFromConfig
    : parseBoolean(INCLUDE_MESSAGE_HIGHLIGHTS_ENV, false);
  const summaryTargets = parseSummaryTargets(SUMMARY_TARGET);
  const telegramMessageMaxChars = toPositiveInt(TELEGRAM_MESSAGE_MAX_CHARS, 3900);
  console.log(`[${new Date().toISOString()}] Running summary job...`);

  const { groupTitle, dateLabel, stats, messages } = await fetchGroupMessagesForToday(client, senderFilter);
  console.log(`Scanned: ${stats.scanned} messages. Included: ${messages.length}.`);
  console.log(
    `Filter diagnostics -> missingDate: ${stats.skippedMissingDate}, afterWindow: ${stats.skippedAfterWindow}, emptyText: ${stats.skippedEmptyText}, senderFilter: ${stats.skippedSenderFilter}, stoppedBeforeWindow: ${stats.stoppedBeforeWindow}`
  );

  const aiMinMessages = toPositiveInt(AI_MIN_MESSAGES_FOR_SUMMARY, 10);
  let aiSummary = null;
  if (!enableAi) {
    console.log('AI summary skipped: disabled for this scheduled run.');
  } else if (messages.length < aiMinMessages) {
    console.log(`AI summary skipped: only ${messages.length} messages (minimum ${aiMinMessages}).`);
  } else {
    try {
      aiSummary = await maybeGenerateAiSummary(messages);
    } catch (err) {
      console.warn(`AI summary skipped: ${err.message}`);
    }
  }

  const summary = buildSummaryText({
    groupTitle,
    dateLabel,
    messages,
    senderFilter,
    aiSummary,
    includeMessageHighlights
  });

  const outDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `summary-${dateLabel}-${timestamp}.txt`);
  fs.writeFileSync(outFile, summary, 'utf8');

  const sentTargets = [];
  for (const target of summaryTargets) {
    try {
      // Keep room for part headers like "[12/12]\n".
      const chunks = splitForTelegram(summary, Math.max(1000, telegramMessageMaxChars - 24));
      for (let i = 0; i < chunks.length; i += 1) {
        const header = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : '';
        await client.sendMessage(target, { message: `${header}${chunks[i]}` });
      }
      if (chunks.length > 1) {
        console.log(`Summary sent to ${target} in ${chunks.length} parts.`);
      }
      sentTargets.push(target);
    } catch (err) {
      console.error(`Failed to send summary to ${target}: ${err.message}`);
    }
  }

  if (sentTargets.length > 0) {
    console.log(`Summary sent to: ${sentTargets.join(', ')}.`);
  } else {
    console.warn('Summary was not sent to any target.');
  }
  console.log(`Saved copy to ${outFile}`);
}

async function main() {
  if (args.has('--init-session')) {
    await initializeSession();
    return;
  }

  const client = await createClient();
  await client.connect();

  if (!STRING_SESSION) {
    console.error('STRING_SESSION is empty. Run: npm run init-session');
    await client.disconnect();
    process.exit(1);
  }

  if (!client.connected) {
    throw new Error('Telegram client connection failed.');
  }

  if (args.has('--run-once')) {
    await runSummaryJob(client);
    await client.disconnect();
    return;
  }

  cron.schedule(
    SUMMARY_CRON_NO_AI,
    () => {
      runSummaryJob(client, { enableAi: true }).catch((err) => console.error('Scheduled run failed:', err));
    },
    { timezone: CRON_TIMEZONE }
  );

  cron.schedule(
    SUMMARY_CRON_WITH_AI,
    () => {
      runSummaryJob(client, { enableAi: true }).catch((err) => console.error('Scheduled run failed:', err));
    },
    { timezone: CRON_TIMEZONE }
  );

  console.log('Telegram daily summary scheduler started.');
  console.log(
    `Schedules (${CRON_TIMEZONE}) -> no-AI: "${SUMMARY_CRON_NO_AI}", with-AI: "${SUMMARY_CRON_WITH_AI}".`
  );
  console.log(`Current local time: ${new Date().toString()}`);

  process.stdin.resume();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
