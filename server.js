import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openHistory } from "./history.js";
import { systemNotify } from "./notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_MS = 20_000;

const PLAN_LABELS = {
  pro_plus: "Pro+",
  pro: "Pro",
  prolite: "Pro Lite",
  pro_lite: "Pro Lite",
  plus: "Plus",
  ultra: "Ultra",
  free: "Gratis",
  free_trial: "Prueba",
  business: "Business",
  team: "Team",
  enterprise: "Enterprise",
  hobby: "Hobby",
};

let cache = { at: 0, key: "", body: null };
const TOOL_IDS = ["cursor", "claude", "codex"];
let claudeSession = { at: 0, cookieHeader: "", org: "" };

function readConfig() {
  const defaults = {
    port: 3851,
    refreshSeconds: 30,
    tools: ["cursor", "claude", "codex"],
    history: true,
    notify: true,
    backgroundMinutes: 5,
  };
  const file = path.join(__dirname, "config.json");
  if (!fs.existsSync(file)) return defaults;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const tools = Array.isArray(raw.tools)
      ? raw.tools.filter((id) => defaults.tools.includes(id))
      : defaults.tools;
    const refresh = Number(raw.refreshSeconds);
    const background = Number(raw.backgroundMinutes);
    return {
      port: Number(raw.port) || defaults.port,
      refreshSeconds:
        Number.isFinite(refresh) && refresh >= 15 ? refresh : defaults.refreshSeconds,
      tools: tools.length ? tools : defaults.tools,
      history: raw.history !== false,
      notify: raw.notify !== false,
      backgroundMinutes:
        Number.isFinite(background) && background >= 0 ? background : defaults.backgroundMinutes,
    };
  } catch {
    return defaults;
  }
}

function planLabel(value) {
  if (!value) return null;
  const key = String(value).toLowerCase();
  return PLAN_LABELS[key] || String(value);
}

function prettyModel(name) {
  const raw = String(name || "Sin modelo")
    .replace(/-\d{8}$/, "")
    .replace(/^claude-/i, "")
    .replace(/^gpt-/i, "gpt-");
  const parts = raw.split(/[-_]/).filter(Boolean);
  while (parts.length >= 2 && /^\d+$/.test(parts.at(-1)) && /^\d+$/.test(parts.at(-2))) {
    const minor = parts.pop();
    parts[parts.length - 1] = `${parts.at(-1)}.${minor}`;
  }
  return parts
    .map((part) =>
      part.toLowerCase() === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
}

function projectFromPath(value) {
  if (!value) return "Sin carpeta";
  const clean = String(value).replace(/[/\\]+$/, "");
  if (clean === os.homedir()) return "Inicio";
  const base = path.basename(clean);
  return base || "Sin carpeta";
}

function projectLabelFromSlug(slug) {
  const markers = ["-Desktop-", "-Documents-", "-Downloads-", "-workspaces-", "-repos-", "-Projects-"];
  for (const marker of markers) {
    const idx = slug.indexOf(marker);
    if (idx !== -1) return slug.slice(idx + marker.length) || "Sin carpeta";
  }
  const match = slug.match(/^Users-[^-]+-(.+)$/);
  return match?.[1] || slug || "Sin carpeta";
}

function bump(map, key, tokens) {
  const amount = Number(tokens) || 0;
  if (!key || amount <= 0) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function ranked(map, limit = 5) {
  const rows = [...map.entries()].filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, tokens]) => sum + tokens, 0);
  const top = rows.slice(0, limit);
  const max = top[0]?.[1] || 1;
  return top.map(([name, tokens]) => ({
    name,
    tokens: Math.round(tokens),
    share: total ? Math.round((tokens / total) * 1000) / 10 : 0,
    width: Math.max(4, Math.round((tokens / max) * 100)),
  }));
}

const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function monthKeyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dayKeyFromDate(date) {
  return `${monthKeyFromDate(date)}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthSeries(tokensByKey) {
  const now = new Date();
  const slots = [];
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKeyFromDate(date);
    const tokens = Math.round(tokensByKey.get(key) || 0);
    const short = MONTH_LABELS[date.getMonth()];
    slots.push({
      label: date.getFullYear() === now.getFullYear() ? short : `${short} ${String(date.getFullYear()).slice(2)}`,
      tokens,
      current: i === 0,
    });
  }
  const max = Math.max(1, ...slots.map((slot) => slot.tokens));
  return slots.map((slot) => ({
    ...slot,
    height: Math.max(slot.tokens ? 12 : 4, Math.round((slot.tokens / max) * 100)),
  }));
}

function daySeries(tokensByKey, count = 14) {
  const now = new Date();
  const slots = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const tokens = Math.round(tokensByKey.get(dayKeyFromDate(date)) || 0);
    slots.push({
      label: String(date.getDate()),
      hint: `${date.getDate()} ${MONTH_LABELS[date.getMonth()]}`,
      tokens,
      current: i === 0,
    });
  }
  const max = Math.max(1, ...slots.map((slot) => slot.tokens));
  return slots.map((slot) => ({
    ...slot,
    height: Math.max(slot.tokens ? 12 : 4, Math.round((slot.tokens / max) * 100)),
  }));
}

function historyPayload(period, modelsMap, projectsMap, monthsMap = new Map(), daysMap = new Map()) {
  const models = ranked(modelsMap);
  const projects = ranked(projectsMap);
  const tokens = [...modelsMap.values()].reduce((sum, n) => sum + n, 0);
  return {
    period,
    tokens: Math.round(tokens),
    models,
    projects,
    months: monthSeries(monthsMap),
    days: daySeries(daysMap),
  };
}

let composerProjects = { at: 0, map: null };
let claudeProjectCache = { at: 0, map: null };

function cursorProjectMap() {
  if (composerProjects.map && Date.now() - composerProjects.at < 60_000) return composerProjects.map;
  const map = new Map();
  const root = path.join(os.homedir(), ".cursor", "projects");
  if (fs.existsSync(root)) {
    for (const slug of fs.readdirSync(root)) {
      const transcripts = path.join(root, slug, "agent-transcripts");
      if (!fs.existsSync(transcripts)) continue;
      const project = projectLabelFromSlug(slug);
      let entries = [];
      try {
        entries = fs.readdirSync(transcripts);
      } catch {
        continue;
      }
      for (const id of entries) {
        if (/^[0-9a-f-]{36}$/i.test(id)) map.set(id, project);
      }
    }
  }
  composerProjects = { at: Date.now(), map };
  return map;
}

async function cursorHistory(headers, userId, startIso, endIso) {
  const models = new Map();
  const projects = new Map();
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !userId) return historyPayload("Este ciclo", models, projects);
  const bodyBase = {
    teamId: 0,
    startDate: String(startMs),
    endDate: String(Math.min(endMs || Date.now(), Date.now())),
    userId,
  };
  try {
    const agg = await fetchJson("https://cursor.com/api/dashboard/get-aggregated-usage-events", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(bodyBase),
    });
    for (const row of agg.aggregations || []) {
      const tokens =
        Number(row.inputTokens || 0) + Number(row.outputTokens || 0) + Number(row.cacheReadTokens || 0);
      bump(models, prettyModel(row.modelIntent || row.model), tokens);
    }
  } catch {
    // el cupo sigue visible aunque falle el desglose
  }
  let seen = 0;
  let reported = 0;
  try {
    const known = cursorProjectMap();
    for (let page = 1; page <= 3; page += 1) {
      const filtered = await fetchJson("https://cursor.com/api/dashboard/get-filtered-usage-events", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...bodyBase, page, pageSize: 200 }),
      });
      const batch = filtered.usageEventsDisplay || [];
      reported = Number(filtered.totalUsageEventsCount || 0);
      seen += batch.length;
      for (const event of batch) {
        const usage = event.tokenUsage || {};
        const tokens =
          Number(usage.inputTokens || 0) +
          Number(usage.outputTokens || 0) +
          Number(usage.cacheReadTokens || 0);
        bump(projects, known.get(event.conversationId), tokens);
      }
      if (batch.length < 200 || seen >= reported) break;
    }
  } catch {
    // proyectos opcionales
  }
  const [months, days] = await Promise.all([
    cursorMonths(headers, userId),
    cursorDays(headers, userId),
  ]);
  return historyPayload(
    reported > seen ? "Modelos de este ciclo. Proyectos de las sesiones recientes." : "Este ciclo",
    models,
    projects,
    months,
    days,
  );
}

let cursorMonthCache = { at: 0, id: "", map: null };
let cursorDayCache = { at: 0, id: "", map: null };

function aggregatedTokens(agg) {
  let tokens = 0;
  for (const row of agg.aggregations || []) {
    tokens += Number(row.inputTokens || 0) + Number(row.outputTokens || 0) + Number(row.cacheReadTokens || 0);
  }
  return tokens;
}

async function cursorSpanMap(headers, userId, slots) {
  const totals = await Promise.all(
    slots.map(async (slot) => {
      try {
        const agg = await fetchJson("https://cursor.com/api/dashboard/get-aggregated-usage-events", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            teamId: 0,
            startDate: String(slot.start),
            endDate: String(Math.min(slot.end, Date.now())),
            userId,
          }),
        });
        return [slot.key, aggregatedTokens(agg)];
      } catch {
        return [slot.key, 0];
      }
    }),
  );
  return new Map(totals);
}

function calendarMonths(count) {
  const now = new Date();
  const slots = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
    slots.push({ key: monthKeyFromDate(start), start: start.getTime(), end: end.getTime() });
  }
  return slots;
}

function calendarDays(count) {
  const now = new Date();
  const slots = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999);
    slots.push({ key: dayKeyFromDate(start), start: start.getTime(), end: end.getTime() });
  }
  return slots;
}

async function cursorMonths(headers, userId) {
  if (!userId) return new Map();
  if (cursorMonthCache.map && cursorMonthCache.id === userId && Date.now() - cursorMonthCache.at < 10 * 60 * 1000) {
    return cursorMonthCache.map;
  }
  const map = await cursorSpanMap(headers, userId, calendarMonths(6));
  cursorMonthCache = { at: Date.now(), id: userId, map };
  return map;
}

async function cursorDays(headers, userId) {
  if (!userId) return new Map();
  if (cursorDayCache.map && cursorDayCache.id === userId && Date.now() - cursorDayCache.at < 10 * 60 * 1000) {
    return cursorDayCache.map;
  }
  const map = await cursorSpanMap(headers, userId, calendarDays(14));
  cursorDayCache = { at: Date.now(), id: userId, map };
  return map;
}

function claudeLocalScan() {
  if (claudeProjectCache.map && Date.now() - claudeProjectCache.at < 60_000) return claudeProjectCache;
  const map = new Map();
  const months = new Map();
  const days = new Map();
  const root = path.join(os.homedir(), ".claude", "projects");
  if (fs.existsSync(root)) {
    for (const dir of fs.readdirSync(root)) {
      const projectPath = path.join(root, dir);
      let files = [];
      try {
        if (!fs.statSync(projectPath).isDirectory()) continue;
        files = fs.readdirSync(projectPath).filter((file) => file.endsWith(".jsonl"));
      } catch {
        continue;
      }
      const project = projectLabelFromSlug(dir.replace(/^-/, ""));
      for (const file of files) {
        const content = fs.readFileSync(path.join(projectPath, file), "utf8");
        for (const line of content.split("\n")) {
          if (!line.includes('"usage"')) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          const usage = obj.message?.usage;
          if (!usage) continue;
          const tokens =
            Number(usage.input_tokens || 0) +
            Number(usage.output_tokens || 0) +
            Number(usage.cache_read_input_tokens || 0) +
            Number(usage.cache_creation_input_tokens || 0);
          bump(map, project, tokens);
          const ts = Date.parse(obj.timestamp);
          if (Number.isFinite(ts)) {
            const date = new Date(ts);
            bump(months, monthKeyFromDate(date), tokens);
            bump(days, dayKeyFromDate(date), tokens);
          }
        }
      }
    }
  }
  claudeProjectCache = { at: Date.now(), map, months, days };
  return claudeProjectCache;
}

function claudeHistory() {
  const models = new Map();
  try {
    const stats = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".claude", "stats-cache.json"), "utf8"),
    );
    for (const [model, usage] of Object.entries(stats.modelUsage || {})) {
      const tokens =
        Number(usage.inputTokens || 0) +
        Number(usage.outputTokens || 0) +
        Number(usage.cacheReadInputTokens || 0) +
        Number(usage.cacheCreationInputTokens || 0);
      bump(models, prettyModel(model), tokens);
    }
  } catch {
    // sin caché local
  }
  let projects = new Map();
  let months = new Map();
  let days = new Map();
  try {
    const scan = claudeLocalScan();
    projects = scan.map;
    months = scan.months;
    days = scan.days;
  } catch {
    projects = new Map();
  }
  return historyPayload("En este equipo", models, projects, months, days);
}

function codexHistory() {
  const models = new Map();
  const projects = new Map();
  const months = new Map();
  const days = new Map();
  const file = path.join(os.homedir(), ".codex", "sqlite", "state_5.sqlite");
  if (!fs.existsSync(file)) return historyPayload("Sesiones locales", models, projects, months, days);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT model, cwd, strftime('%Y-%m-%d', created_at_ms / 1000, 'unixepoch', 'localtime') AS day,
                SUM(COALESCE(tokens_used, 0)) AS tokens
         FROM threads
         GROUP BY model, cwd, day`,
      )
      .all();
    for (const row of rows) {
      const day = String(row.day || "");
      bump(models, prettyModel(row.model), row.tokens);
      bump(projects, projectFromPath(row.cwd), row.tokens);
      bump(months, day.slice(0, 7), row.tokens);
      bump(days, day, row.tokens);
    }
  } catch {
    // el cupo semanal sigue visible
  } finally {
    db?.close();
  }
  return historyPayload("Sesiones locales", models, projects, months, days);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clampUsed(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, n);
}

function meter(label, used, extra = {}) {
  const value = clampUsed(used);
  if (value == null) return null;
  return {
    label,
    used: round1(value),
    left: round1(Math.max(0, 100 - value)),
    ...extra,
  };
}

function toMs(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function formatWhen(isoOrMs) {
  const date = new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDistance(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "ya";
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${Math.max(1, minutes)} min`;
}

function fail(id, name, message) {
  return { id, name, ok: false, error: message, plan: null, meters: [], note: null, detail: null };
}

function safeMessage(error) {
  return String(error?.message || error || "Error desconocido")
    .replace(/eyJ[\w.-]+/g, "[token]")
    .slice(0, 180);
}

async function fetchJson(url, options, timeoutMs = 15000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail =
      data?.error?.message || data?.error || data?.message || text || `HTTP ${res.status}`;
    const err = new Error(safeMessage(detail));
    err.status = res.status;
    throw err;
  }
  return data;
}

function cursorDbPath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData/Roaming"), "Cursor/User/globalStorage/state.vscdb");
  }
  return path.join(home, ".config/Cursor/User/globalStorage/state.vscdb");
}

function readCursorAuth() {
  const dbPath = cursorDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error("No veo Cursor en este equipo. Ábrelo, entra en tu cuenta y pulsa Actualizar.");
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
    const accessToken = row?.value;
    if (!accessToken) {
      throw new Error("Cursor está, pero sin sesión. Entra en tu cuenta y pulsa Actualizar.");
    }
    const part = accessToken.split(".")[1];
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    const cookie = `WorkosCursorSessionToken=${encodeURIComponent(payload.sub || "")}%3A%3A${accessToken}`;
    return { cookie };
  } finally {
    db.close();
  }
}

async function loadCursor() {
  const { cookie } = readCursorAuth();
  const headers = {
    Accept: "application/json",
    Cookie: cookie,
    Origin: "https://cursor.com",
  };
  const [summary, period, me] = await Promise.all([
    fetchJson("https://cursor.com/api/usage-summary", { headers }),
    fetchJson("https://cursor.com/api/dashboard/get-current-period-usage", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    }),
    fetchJson("https://cursor.com/api/auth/me", { headers }),
  ]);

  const planUsage = period.planUsage || {};
  const individual = summary.individualUsage?.plan || {};
  const total = planUsage.totalPercentUsed ?? individual.totalPercentUsed;
  const api = planUsage.apiPercentUsed ?? individual.apiPercentUsed;
  const auto = planUsage.autoPercentUsed ?? individual.autoPercentUsed;
  const onDemand = summary.individualUsage?.onDemand || {};
  const cycleEnd = summary.billingCycleEnd || period.billingCycleEnd;

  const cycle = { resetAt: toMs(cycleEnd) };
  const meters = [
    meter("Uso incluido", total, cycle),
    meter("API incluida", api, cycle),
    meter("Auto", auto, cycle),
  ].filter(Boolean);

  const apiMeter = meters.find((row) => row.label === "API incluida");
  const totalMeter = meters.find((row) => row.label === "Uso incluido");
  let detail = null;
  if (apiMeter && apiMeter.used >= 100 && totalMeter && totalMeter.used < 100) {
    detail = "La API incluida está agotada. El uso total del plan todavía tiene margen.";
  } else if (totalMeter && totalMeter.used >= 100) {
    detail = "El uso incluido de este ciclo está agotado.";
  }

  const notes = [];
  if (cycleEnd) notes.push(`El ciclo acaba el ${formatWhen(cycleEnd)}.`);
  if (onDemand.enabled) notes.push("El uso extra está activado.");
  const history = await cursorHistory(
    headers,
    me.id,
    summary.billingCycleStart || period.billingCycleStart,
    summary.billingCycleEnd || period.billingCycleEnd,
  );

  return {
    id: "cursor",
    name: "Cursor",
    ok: true,
    error: null,
    plan: planLabel(summary.membershipType),
    source: "Sesión de Cursor",
    meters,
    note: notes.join(" "),
    detail,
    history,
  };
}

function readClaudeFileToken() {
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const oauth = raw.claudeAiOauth || {};
  if (!oauth.accessToken) return null;
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) return null;
  return { token: oauth.accessToken, plan: planLabel(oauth.subscriptionType) };
}

function decryptChromeCookie(encryptedValue, key) {
  const buf = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue);
  if (buf.subarray(0, 3).toString() !== "v10") throw new Error("cookie no es v10");
  const iv = Buffer.alloc(16, " ");
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  return plain.subarray(32).toString("utf8").replace(/\0+$/, "").replace(/^[^\x20-\x7E]+/, "");
}

function readClaudeDesktopSession() {
  if (process.platform !== "darwin") return null;
  if (claudeSession.cookieHeader && Date.now() - claudeSession.at < 10 * 60 * 1000) {
    return claudeSession;
  }
  const cookiesPath = path.join(os.homedir(), "Library/Application Support/Claude/Cookies");
  if (!fs.existsSync(cookiesPath)) return null;
  const password = execFileSync(
    "security",
    ["find-generic-password", "-w", "-s", "Claude Safe Storage", "-a", "Claude Key"],
    { encoding: "utf8" },
  ).trim();
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const db = new DatabaseSync(cookiesPath, { readOnly: true });
  let rows;
  try {
    rows = db
      .prepare("SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%claude%'")
      .all();
  } finally {
    db.close();
  }
  const cookies = {};
  for (const row of rows) {
    try {
      cookies[row.name] = decryptChromeCookie(row.encrypted_value, key);
    } catch {
      // una cookie ilegible no invalida el resto
    }
  }
  if (!cookies.sessionKey || !cookies.lastActiveOrg) return null;
  claudeSession = {
    at: Date.now(),
    cookieHeader: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    org: cookies.lastActiveOrg,
  };
  return claudeSession;
}

function claudePlanFromFile() {
  try {
    const file = path.join(os.homedir(), ".claude", ".credentials.json");
    const oauth = JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth || {};
    return planLabel(oauth.subscriptionType);
  } catch {
    return null;
  }
}

function claudeMeters(usage) {
  const limits = Array.isArray(usage?.limits) ? usage.limits : [];
  if (limits.length) {
    const wanted = [
      ["session", "Sesión"],
      ["weekly_all", "Semana"],
    ];
    const fromLimits = wanted
      .map(([kind, label]) => {
        const row = limits.find((item) => item.kind === kind);
        if (!row || row.percent == null) return null;
        const reset = row.resets_at
          ? `se reinicia el ${formatWhen(row.resets_at)}`
          : kind === "session" && row.is_active === false
            ? "empieza con el primer mensaje"
            : null;
        return meter(label, Number(row.percent), { reset, resetAt: toMs(row.resets_at) });
      })
      .filter(Boolean);
    if (fromLimits.length) return fromLimits;
  }
  const windows = [
    ["five_hour", "Sesión"],
    ["seven_day", "Semana"],
    ["seven_day_opus", "Semana · Opus"],
    ["seven_day_sonnet", "Semana · Sonnet"],
  ];
  return windows
    .map(([key, label]) => {
      const row = usage?.[key];
      if (!row || row.utilization == null) return null;
      const raw = Number(row.utilization);
      const used = raw <= 1 ? raw * 100 : raw;
      const reset = row.resets_at ? `se reinicia el ${formatWhen(row.resets_at)}` : null;
      return meter(label, used, { reset, resetAt: toMs(row.resets_at) });
    })
    .filter(Boolean);
}

async function loadClaude() {
  const fileToken = readClaudeFileToken();
  let usage = null;
  let source = null;
  if (fileToken) {
    usage = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${fileToken.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
      },
    });
    source = "Sesión de Claude Code";
  } else {
    let session;
    try {
      session = readClaudeDesktopSession();
    } catch {
      throw new Error(
        "macOS quiere confirmar que puedes ver Claude. Cuando salga el aviso, pulsa Permitir y luego Actualizar.",
      );
    }
    if (!session) {
      throw new Error(
        "No encuentro Claude Desktop. Ábrelo, inicia sesión y pulsa Actualizar. Si solo usas Claude Code, también vale esa sesión.",
      );
    }
    usage = await fetchJson(`https://claude.ai/api/organizations/${session.org}/usage`, {
      headers: {
        Cookie: session.cookieHeader,
        Referer: "https://claude.ai/settings/usage",
        Origin: "https://claude.ai",
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    source = "Sesión de Claude Desktop";
  }

  const meters = claudeMeters(usage);
  if (!meters.length) {
    throw new Error("Claude ha respondido, pero sin los límites. Espera un momento y pulsa Actualizar.");
  }
  const tight = meters.reduce((a, b) => (b.used > a.used ? b : a));
  const detail = tight.used >= 100 ? "La semana está al límite." : null;

  return {
    id: "claude",
    name: "Claude",
    ok: true,
    error: null,
    plan: fileToken?.plan || claudePlanFromFile(),
    source,
    meters,
    note: tight.reset ? `${tight.reset.charAt(0).toUpperCase()}${tight.reset.slice(1)}.` : null,
    detail,
    history: claudeHistory(),
  };
}

function readCodexAuth() {
  const file = path.join(os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(file)) {
    throw new Error("No veo Codex en este equipo. Ábrelo, o escribe codex login en la terminal, y pulsa Actualizar.");
  }
  const auth = JSON.parse(fs.readFileSync(file, "utf8"));
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!token || !accountId) {
    throw new Error("Codex está instalado, pero sin sesión. En la terminal escribe codex login y vuelve aquí.");
  }
  return { token, accountId };
}

function windowMeter(label, window) {
  if (!window || window.used_percent == null) return null;
  const seconds = Number(window.limit_window_seconds);
  const name =
    label ||
    (seconds >= 6 * 24 * 3600 ? "Semana" : seconds > 0 && seconds <= 6 * 3600 ? "5 horas" : "Ventana");
  const resetMs = Number(window.reset_after_seconds) * 1000;
  const reset = Number.isFinite(resetMs) ? `se reinicia en ${formatDistance(resetMs)}` : null;
  const resetAt = Number.isFinite(resetMs) ? Date.now() + resetMs : null;
  return meter(name, Number(window.used_percent), { reset, resetAt });
}

async function loadCodex() {
  const { token, accountId } = readCodexAuth();
  const data = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
    },
  });
  const meters = [
    windowMeter(null, data.rate_limit?.primary_window),
    windowMeter("Ventana corta", data.rate_limit?.secondary_window),
  ].filter(Boolean);
  if (!meters.length) {
    throw new Error("Codex ha respondido sin el límite semanal. Prueba a actualizar en un momento.");
  }
  const main = meters[0];
  let detail = null;
  if (data.rate_limit?.limit_reached || main.used >= 100) {
    detail = "La ventana de Codex está agotada.";
  }
  return {
    id: "codex",
    name: "Codex",
    ok: true,
    error: null,
    plan: planLabel(data.plan_type),
    source: "Sesión de Codex",
    meters,
    note: main.reset ? `La ventana ${main.reset}.` : null,
    detail,
    history: codexHistory(),
  };
}

const LOADERS = {
  cursor: loadCursor,
  claude: loadClaude,
  codex: loadCodex,
};

const NAMES = { cursor: "Cursor", claude: "Claude", codex: "Codex" };

function cursorAccountLabel(token) {
  try {
    const part = String(token).split(".")[1];
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    const email = payload.email;
    if (typeof email === "string" && email.includes("@") && email.length < 120) return email;
  } catch {
    // el token sigue sirviendo para el consumo
  }
  return null;
}

function probeCursor() {
  const dbPath = cursorDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      status: "missing",
      detail: "No está en este equipo.",
      help: "Instala Cursor, ábrelo, entra en tu cuenta y pulsa Volver a mirar.",
    };
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let token = "";
    let email = "";
    try {
      const read = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
      token = read.get("cursorAuth/accessToken")?.value || "";
      email = String(read.get("cursorAuth/cachedEmail")?.value || "").replaceAll('"', "").trim();
    } finally {
      db.close();
    }
    if (!token) {
      return {
        status: "installed",
        detail: "Cursor está, sin sesión.",
        help: "Abre Cursor, entra en tu cuenta y pulsa Volver a mirar.",
      };
    }
    const who = email.includes("@") ? email : cursorAccountLabel(token);
    return {
      status: "ready",
      detail: who ? `Sesión de ${who}` : "Sesión abierta en este equipo.",
      help: null,
    };
  } catch {
    return {
      status: "installed",
      detail: "Cursor está, pero no he podido leer la sesión.",
      help: "Cierra y abre Cursor, y pulsa Volver a mirar.",
    };
  }
}

function claudeFileState() {
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  if (!fs.existsSync(file)) return "none";
  try {
    const oauth = JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth || {};
    if (!oauth.accessToken) return "none";
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) return "expired";
    return "ready";
  } catch {
    return "none";
  }
}

function claudeDesktopHasSession() {
  if (process.platform !== "darwin") return false;
  const cookiesPath = path.join(os.homedir(), "Library/Application Support/Claude/Cookies");
  if (!fs.existsSync(cookiesPath)) return false;
  const db = new DatabaseSync(cookiesPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT name FROM cookies WHERE name = 'sessionKey' AND host_key LIKE '%claude%'")
      .get();
    return Boolean(row);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function probeClaude() {
  const fileState = claudeFileState();
  if (fileState === "ready") {
    return {
      status: "ready",
      detail: "Sesión de Claude Code.",
      help: null,
      needsKeychain: false,
    };
  }
  let desktop = false;
  try {
    desktop = claudeDesktopHasSession();
  } catch {
    desktop = false;
  }
  if (desktop) {
    return {
      status: "ready",
      detail: "Claude Desktop tiene sesión.",
      help: "Al ver el consumo, macOS puede pedir permiso. Pulsa Permitir: solo se lee la sesión de este equipo.",
      needsKeychain: true,
    };
  }
  const installed =
    fileState === "expired" ||
    fs.existsSync(path.join(os.homedir(), ".claude")) ||
    fs.existsSync("/Applications/Claude.app");
  if (fileState === "expired") {
    return {
      status: "installed",
      detail: "La sesión de Claude Code ha caducado.",
      help: "Abre Claude Code o Claude Desktop, entra otra vez y pulsa Volver a mirar.",
      needsKeychain: false,
    };
  }
  if (installed) {
    return {
      status: "installed",
      detail: "Claude está, sin sesión usable.",
      help: "Ábrelo, inicia sesión y pulsa Volver a mirar.",
      needsKeychain: false,
    };
  }
  return {
    status: "missing",
    detail: "No está en este equipo.",
    help: "Instala Claude Desktop o Claude Code, entra y pulsa Volver a mirar.",
    needsKeychain: false,
  };
}

function codexAccountLabel(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    const email = payload["https://api.openai.com/profile"]?.email;
    if (typeof email === "string" && email.includes("@") && email.length < 120) return email;
  } catch {
    // sin correo, la sesión sigue contando
  }
  return null;
}

function probeCodex() {
  const file = path.join(os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(file)) {
    const installed = fs.existsSync(path.join(os.homedir(), ".codex"));
    return installed
      ? {
          status: "installed",
          detail: "Codex está, sin sesión.",
          help: "En la terminal escribe codex login y pulsa Volver a mirar.",
        }
      : {
          status: "missing",
          detail: "No está en este equipo.",
          help: "Instala Codex, entra con codex login y pulsa Volver a mirar.",
        };
  }
  try {
    const auth = JSON.parse(fs.readFileSync(file, "utf8"));
    if (auth.tokens?.access_token && auth.tokens?.account_id) {
      const who = codexAccountLabel(auth.tokens.access_token);
      return {
        status: "ready",
        detail: who ? `Sesión de ${who}` : "Sesión abierta en este equipo.",
        help: null,
      };
    }
    return {
      status: "installed",
      detail: "Codex está instalado, pero sin sesión.",
      help: "En la terminal escribe codex login y pulsa Volver a mirar.",
    };
  } catch {
    return {
      status: "installed",
      detail: "No he podido leer la sesión de Codex.",
      help: "Vuelve a entrar con codex login y pulsa Volver a mirar.",
    };
  }
}

function probeLocal() {
  const probes = { cursor: probeCursor, claude: probeClaude, codex: probeCodex };
  return TOOL_IDS.map((id) => {
    try {
      return { id, name: NAMES[id], needsKeychain: false, ...probes[id]() };
    } catch {
      return {
        id,
        name: NAMES[id],
        status: "installed",
        detail: "No he podido comprobarlo.",
        help: "Pulsa Volver a mirar en un momento.",
        needsKeychain: false,
      };
    }
  });
}

async function loadTool(id) {
  try {
    return await LOADERS[id]();
  } catch (error) {
    return fail(id, NAMES[id], safeMessage(error));
  }
}

function toolsFromQuery(searchParams, fallback) {
  const raw = searchParams.get("tools");
  if (!raw) return fallback;
  const picked = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => TOOL_IDS.includes(id));
  return [...new Set(picked)];
}

let history = null;

function startHistory(config) {
  if (!config.history) return null;
  const dir = process.env.CONSUMO_DATA || path.join(__dirname, "data");
  try {
    return openHistory(path.join(dir, "consumo.sqlite"));
  } catch (error) {
    console.warn(`Sin historial: ${safeMessage(error)}`);
    return null;
  }
}

function forecastText(meter, forecast, now) {
  if (!forecast) return null;
  if (!forecast.runsOutAt) {
    return meter.resetAt ? "Ahora mismo no estás gastando: llegas al reinicio igual." : null;
  }
  if (forecast.beforeReset) {
    return `A este ritmo se acaba en ${formatDistance(forecast.runsOutAt - now)}, el ${formatWhen(forecast.runsOutAt)}.`;
  }
  if (forecast.leftAtReset != null) {
    return `A este ritmo llegas al reinicio con un ${forecast.leftAtReset} % libre.`;
  }
  return `A este ritmo se acaba el ${formatWhen(forecast.runsOutAt)}.`;
}

function addForecasts(rows, now) {
  if (!history) return;
  for (const tool of rows) {
    if (!tool.ok) continue;
    for (const meter of tool.meters) {
      try {
        const forecast = history.forecast(tool.id, meter, now);
        if (forecast) meter.forecast = { ...forecast, text: forecastText(meter, forecast, now) };
      } catch {
        // la previsión es opcional
      }
    }
  }
}

function alertMessage(alert) {
  const { tool, meter } = alert;
  if (alert.kind === "reset") {
    return { title: `${tool.name}: ${meter.label.toLowerCase()} reiniciada`, body: `Vuelves a tener un ${Math.round(meter.left)} % libre.` };
  }
  const title = alert.level >= 100 ? `${tool.name}: ${meter.label.toLowerCase()} agotada` : `${tool.name}: ${meter.label.toLowerCase()} al ${Math.round(meter.used)} %`;
  const lines = [];
  if (meter.forecast?.text && alert.level < 100) lines.push(meter.forecast.text);
  if (meter.reset) lines.push(`${meter.reset.charAt(0).toUpperCase()}${meter.reset.slice(1)}.`);
  return { title, body: lines.join(" ") || `Queda un ${Math.round(meter.left)} %.` };
}

function notifyChanges(config, rows) {
  if (!history || !config.notify || process.env.NO_NOTIFY) return;
  for (const alert of history.alerts(rows)) {
    const { title, body } = alertMessage(alert);
    systemNotify(title, body);
  }
}

async function buildPayload(config, tools, fresh) {
  const key = tools.join(",");
  if (!fresh && cache.body && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return cache.body;
  }
  const rows = await Promise.all(tools.map((id) => loadTool(id)));
  const now = Date.now();
  if (history) {
    try {
      history.record(rows, now);
      addForecasts(rows, now);
      notifyChanges(config, rows);
    } catch (error) {
      console.warn(`Historial: ${safeMessage(error)}`);
    }
  }
  const body = {
    fetchedAt: new Date().toISOString(),
    refreshSeconds: config.refreshSeconds,
    tools: rows,
  };
  cache = { at: Date.now(), key, body };
  return body;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const config = readConfig();
const port = Number(process.env.PORT) || config.port;
history = startHistory(config);

function savedTools() {
  try {
    return toolsFromQuery(new URLSearchParams({ tools: history?.getMeta("tools") || "" }), []);
  } catch {
    return [];
  }
}

function rememberTools(searchParams, tools) {
  if (!history || !searchParams.get("tools")) return;
  try {
    const value = tools.join(",");
    if (history.getMeta("tools") !== value) history.setMeta("tools", value);
  } catch {
    // no recordarlo solo apaga la vigilancia en segundo plano
  }
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function historyCsv() {
  const lines = ["fecha,herramienta,medidor,usado,reinicio"];
  for (const row of history?.rows() || []) {
    lines.push(
      [
        new Date(row.at).toISOString(),
        row.tool,
        row.meter,
        row.used,
        row.reset_at ? new Date(row.reset_at).toISOString() : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

// Sigue mirando aunque el panel esté cerrado, para que haya historial y avisos.
// Solo mira las cuentas que elegiste en el panel; si todavía no elegiste, no hace nada.
function startBackground() {
  const minutes = config.backgroundMinutes;
  if (!history || !minutes) return;
  const tick = async () => {
    const tools = savedTools();
    if (!tools.length || Date.now() - cache.at < minutes * 60 * 1000 * 0.8) return;
    try {
      await buildPayload(config, tools, true);
    } catch {
      // el siguiente intento vuelve a probar
    }
  };
  setInterval(tick, minutes * 60 * 1000).unref();
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLocalHost(req) {
  const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (!isLocalHost(req)) {
    // otra web que apunta su dominio a 127.0.0.1 no puede leer el panel
    send(res, 403, JSON.stringify({ error: "Solo desde este equipo." }));
    return;
  }
  try {
    if (url.pathname === "/api/health") {
      send(res, 200, JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/local") {
      send(res, 200, JSON.stringify({ accounts: probeLocal() }));
      return;
    }
    if (url.pathname === "/api/usage") {
      const tools = toolsFromQuery(url.searchParams, config.tools);
      if (!tools.length) {
        send(res, 400, JSON.stringify({ error: "Elige al menos una suscripción." }));
        return;
      }
      rememberTools(url.searchParams, tools);
      const body = await buildPayload(config, tools, url.searchParams.get("fresh") === "1");
      send(res, 200, JSON.stringify(body));
      return;
    }
    if (url.pathname === "/api/history.csv") {
      if (!history) {
        send(res, 404, JSON.stringify({ error: "El historial está apagado." }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="consumo.csv"',
        "Cache-Control": "no-store",
      });
      res.end(historyCsv());
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, "index.html")), "text/html; charset=utf-8");
      return;
    }
    send(res, 404, JSON.stringify({ error: "No está" }));
  } catch (error) {
    send(res, 500, JSON.stringify({ error: safeMessage(error) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  const page = `http://127.0.0.1:${port}`;
  console.log(`Consumo en ${page}`);
  startBackground();
  if (process.platform === "darwin" && !process.env.NO_OPEN) {
    execFileSync("open", [page]);
  }
});
