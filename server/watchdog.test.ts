// server/watchdog.test.ts
import { describe, test, expect } from "bun:test";
import { createWatchdog } from "./watchdog";

describe("watchdog", () => {
  test("check() returns true when probe succeeds", () => {
    const wd = createWatchdog({
      claudePid: 1234,
      intervalMs: 1000,
      onOrphaned: () => {},
      probe: () => { /* alive */ },
    });
    expect(wd.check()).toBe(true);
  });

  test("check() returns false when probe throws ESRCH", () => {
    const wd = createWatchdog({
      claudePid: 1234,
      intervalMs: 1000,
      onOrphaned: () => {},
      probe: () => {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
    });
    expect(wd.check()).toBe(false);
  });

  test("check() treats EPERM as alive", () => {
    const wd = createWatchdog({
      claudePid: 1234,
      intervalMs: 1000,
      onOrphaned: () => {},
      probe: () => {
        const err = new Error("perm") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
    });
    expect(wd.check()).toBe(true);
  });

  test("calls onOrphaned exactly once when pid dies", async () => {
    let alive = true;
    let calls = 0;
    const wd = createWatchdog({
      claudePid: 1234,
      intervalMs: 20,
      onOrphaned: () => { calls++; },
      probe: () => {
        if (!alive) {
          const err = new Error("gone") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
      },
    });
    wd.start();
    await new Promise((r) => setTimeout(r, 60));
    alive = false;
    await new Promise((r) => setTimeout(r, 100));
    wd.stop();
    expect(calls).toBe(1);
  });

  test("does not fire when pid stays alive", async () => {
    let calls = 0;
    const wd = createWatchdog({
      claudePid: 1234,
      intervalMs: 20,
      onOrphaned: () => { calls++; },
      probe: () => { /* always alive */ },
    });
    wd.start();
    await new Promise((r) => setTimeout(r, 100));
    wd.stop();
    expect(calls).toBe(0);
  });

  test("stop() prevents further ticks", async () => {
    let probes = 0;
    const wd = createWatchdog({
      claudePid: 1234,
      intervalMs: 20,
      onOrphaned: () => {},
      probe: () => { probes++; },
    });
    wd.start();
    await new Promise((r) => setTimeout(r, 60));
    wd.stop();
    const after = probes;
    await new Promise((r) => setTimeout(r, 80));
    expect(probes).toBe(after);
  });
});
