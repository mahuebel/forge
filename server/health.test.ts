// server/health.test.ts
import { describe, test, expect } from "bun:test";
import { createHeartbeatEmitter } from "./health";

describe("heartbeat emitter", () => {
  test("calls onHeartbeat at specified interval", async () => {
    let callCount = 0;
    const emitter = createHeartbeatEmitter({
      intervalMs: 50,
      getEventsSent: () => callCount,
      onHeartbeat: () => { callCount++; },
    });

    emitter.start();
    await new Promise((r) => setTimeout(r, 160));
    emitter.stop();

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(callCount).toBeLessThanOrEqual(4);
  });

  test("getUptimeSeconds returns elapsed time", async () => {
    const emitter = createHeartbeatEmitter({
      intervalMs: 1000,
      getEventsSent: () => 0,
      onHeartbeat: () => {},
    });
    emitter.start();
    await new Promise((r) => setTimeout(r, 100));
    const uptime = emitter.getUptimeSeconds();
    expect(uptime).toBeGreaterThanOrEqual(0);
    emitter.stop();
  });
});
