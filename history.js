import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Cada lectura del panel se guarda como una foto: herramienta, medidor, % usado y
// cuándo se reinicia. Con eso se ve el ritmo y se calcula cuándo se acaba.
// No se guardan tokens de sesión, ni correos, ni nada que identifique la cuenta.

const MIN_GAP_MS = 4 * 60 * 1000;
const KEEP_MS = 60 * 24 * 3600 * 1000;
const LOOKBACK_MS = 24 * 3600 * 1000;
const MIN_SPAN_MS = 15 * 60 * 1000;
const RESET_DROP = 15;
const RESET_SHIFT_MS = 60 * 60 * 1000;
export const ALERT_LEVELS = [80, 95, 100];
const QUIET_METERS = new Set(["API incluida", "Auto"]);

function levelOf(used) {
  let level = 0;
  for (const mark of ALERT_LEVELS) if (used >= mark) level = mark;
  return level;
}

// Se queda con las fotos de la ventana actual: corta donde el uso cae de golpe
// o donde cambia la fecha de reinicio.
export function currentWindow(points) {
  let start = points.length - 1;
  while (start > 0) {
    const prev = points[start - 1];
    const next = points[start];
    const dropped = prev.used - next.used > RESET_DROP;
    const shifted =
      prev.reset_at && next.reset_at && Math.abs(prev.reset_at - next.reset_at) > RESET_SHIFT_MS;
    if (dropped || shifted) break;
    start -= 1;
  }
  return points.slice(start);
}

// Ritmo en puntos por milisegundo, con las fotos de las últimas 24 horas de la ventana.
export function paceOf(points, now) {
  const window = currentWindow(points).filter((p) => p.at >= now - LOOKBACK_MS);
  if (window.length < 2) return null;
  const first = window[0];
  const last = window.at(-1);
  const span = last.at - first.at;
  if (span < MIN_SPAN_MS) return null;
  return Math.max(0, (last.used - first.used) / span);
}

// Devuelve números; el texto lo pone el servidor.
export function forecastOf(points, meter, now) {
  if (!meter || meter.used >= 100) return null;
  const rate = paceOf(points, now);
  if (rate == null) return null;
  const perHour = Math.round(rate * 3600 * 1000 * 10) / 10;
  const resetAt = Number(meter.resetAt) || null;
  if (rate <= 0) return { perHour: 0, runsOutAt: null, beforeReset: false, leftAtReset: resetAt ? meter.left : null };
  const runsOutAt = Math.round(now + (100 - meter.used) / rate);
  if (resetAt && runsOutAt >= resetAt) {
    const usedAtReset = Math.min(100, meter.used + rate * (resetAt - now));
    return {
      perHour,
      runsOutAt,
      beforeReset: false,
      leftAtReset: Math.round(Math.max(0, 100 - usedAtReset)),
    };
  }
  return { perHour, runsOutAt, beforeReset: true, leftAtReset: resetAt ? 0 : null };
}

export function openHistory(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      at INTEGER NOT NULL,
      tool TEXT NOT NULL,
      meter TEXT NOT NULL,
      used REAL NOT NULL,
      reset_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS snapshots_key ON snapshots (tool, meter, at);
    CREATE TABLE IF NOT EXISTS alerts (
      tool TEXT NOT NULL,
      meter TEXT NOT NULL,
      level INTEGER NOT NULL,
      PRIMARY KEY (tool, meter)
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  const lastOf = db.prepare(
    "SELECT at, used, reset_at FROM snapshots WHERE tool = ? AND meter = ? ORDER BY at DESC LIMIT 1",
  );
  const insert = db.prepare(
    "INSERT INTO snapshots (at, tool, meter, used, reset_at) VALUES (?, ?, ?, ?, ?)",
  );
  const recent = db.prepare(
    `SELECT at, used, reset_at FROM (
       SELECT at, used, reset_at FROM snapshots
       WHERE tool = ? AND meter = ? AND at >= ?
       ORDER BY at DESC LIMIT 2000
     ) ORDER BY at`,
  );
  const prune = db.prepare("DELETE FROM snapshots WHERE at < ?");
  const alertOf = db.prepare("SELECT level FROM alerts WHERE tool = ? AND meter = ?");
  const setAlert = db.prepare(
    "INSERT INTO alerts (tool, meter, level) VALUES (?, ?, ?) ON CONFLICT (tool, meter) DO UPDATE SET level = excluded.level",
  );
  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const all = db.prepare("SELECT at, tool, meter, used, reset_at FROM snapshots ORDER BY at");
  let prunedAt = 0;

  return {
    record(tools, now = Date.now()) {
      for (const tool of tools) {
        if (!tool.ok) continue;
        for (const meter of tool.meters || []) {
          const last = lastOf.get(tool.id, meter.label);
          const resetAt = Number(meter.resetAt) || null;
          const moved = last && Math.abs(last.used - meter.used) >= 1;
          if (last && now - last.at < MIN_GAP_MS && !moved) continue;
          insert.run(now, tool.id, meter.label, meter.used, resetAt);
        }
      }
      if (now - prunedAt > 3600 * 1000) {
        prune.run(now - KEEP_MS);
        prunedAt = now;
      }
    },

    points(toolId, meterLabel, now = Date.now(), sinceMs = 35 * 24 * 3600 * 1000) {
      return recent.all(toolId, meterLabel, now - sinceMs);
    },

    forecast(toolId, meter, now = Date.now()) {
      return forecastOf(this.points(toolId, meter.label, now), meter, now);
    },

    // Devuelve los cambios de nivel que merecen aviso, y deja apuntado el nivel nuevo.
    alerts(tools) {
      const out = [];
      for (const tool of tools) {
        if (!tool.ok) continue;
        for (const meter of tool.meters || []) {
          if (QUIET_METERS.has(meter.label)) continue;
          const level = levelOf(meter.used);
          const prev = alertOf.get(tool.id, meter.label)?.level ?? 0;
          if (level === prev) continue;
          setAlert.run(tool.id, meter.label, level);
          if (level > prev) out.push({ kind: "level", tool, meter, level });
          else if (prev >= ALERT_LEVELS[0] && meter.used < 50) out.push({ kind: "reset", tool, meter });
        }
      }
      return out;
    },

    getMeta(key) {
      return getMeta.get(key)?.value ?? null;
    },

    setMeta(key, value) {
      setMeta.run(key, String(value));
    },

    rows() {
      return all.all();
    },

    close() {
      db.close();
    },
  };
}
