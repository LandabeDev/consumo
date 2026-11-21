import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentWindow, forecastOf, openHistory } from "../history.js";

const H = 3600 * 1000;
const now = Date.UTC(2026, 10, 20, 12);

function point(hoursAgo, used, resetAt = null) {
  return { at: now - hoursAgo * H, used, reset_at: resetAt };
}

test("la ventana empieza después del último reinicio", () => {
  const points = [point(10, 90), point(9, 95), point(8, 5), point(7, 10), point(6, 20)];
  assert.deepEqual(currentWindow(points).map((p) => p.used), [5, 10, 20]);
});

test("un cambio de fecha de reinicio también corta la ventana", () => {
  const a = now + 2 * H;
  const b = now + 30 * H;
  const points = [point(5, 10, a), point(4, 12, a), point(3, 13, b), point(2, 14, b)];
  assert.deepEqual(currentWindow(points).map((p) => p.used), [13, 14]);
});

test("avisa si se acaba antes del reinicio", () => {
  const resetAt = now + 10 * H;
  const points = [point(4, 40), point(2, 50), point(0, 60)];
  const f = forecastOf(points, { used: 60, left: 40, resetAt }, now);
  assert.equal(f.perHour, 5);
  assert.equal(f.beforeReset, true);
  assert.equal(f.runsOutAt, now + 8 * H);
});

test("si llega al reinicio, dice cuánto sobra", () => {
  const resetAt = now + 4 * H;
  const points = [point(4, 40), point(0, 60)];
  const f = forecastOf(points, { used: 60, left: 40, resetAt }, now);
  assert.equal(f.beforeReset, false);
  assert.equal(f.leftAtReset, 20);
});

test("sin datos suficientes no se inventa nada", () => {
  assert.equal(forecastOf([point(0, 50)], { used: 50, left: 50 }, now), null);
  assert.equal(forecastOf([point(0.1, 49), point(0, 50)], { used: 50, left: 50 }, now), null);
});

test("guarda fotos, avisa una vez por nivel y avisa del reinicio", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consumo-"));
  const h = openHistory(path.join(dir, "test.sqlite"));
  const tool = (used) => [{ id: "claude", name: "Claude", ok: true, meters: [{ label: "Semana", used, left: 100 - used }] }];
  try {
    h.record(tool(50), now - 2 * H);
    h.record(tool(50.2), now - 2 * H + 60_000);
    h.record(tool(70), now);
    assert.equal(h.rows().length, 2);

    assert.equal(h.alerts(tool(50)).length, 0);
    assert.deepEqual(h.alerts(tool(82)).map((a) => a.level), [80]);
    assert.equal(h.alerts(tool(85)).length, 0);
    assert.deepEqual(h.alerts(tool(96)).map((a) => a.level), [95]);
    assert.deepEqual(h.alerts(tool(3)).map((a) => a.kind), ["reset"]);

    h.setMeta("tools", "claude,codex");
    assert.equal(h.getMeta("tools"), "claude,codex");
  } finally {
    h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
