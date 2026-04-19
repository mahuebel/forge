// server/watchdog.ts
//
// Polls the owning Claude Code process and triggers shutdown when it exits.
// Without this, per-session forge servers leak — they outlive the Claude
// session that spawned them and accumulate across reboots.
//
// `process.kill(pid, 0)` doesn't actually signal; it just probes whether
// the pid is alive and signalable. Throws ESRCH when the process is gone,
// EPERM when it exists but we can't signal it (shouldn't happen for our
// own parent — included as "alive" to be safe).

export interface WatchdogConfig {
  claudePid: number;
  intervalMs: number;
  onOrphaned: () => void;
  /** Injectable for tests. Defaults to process.kill. */
  probe?: (pid: number) => void;
}

export interface Watchdog {
  start: () => void;
  stop: () => void;
  /** Exposed for tests — returns true if the owning pid is still alive. */
  check: () => boolean;
}

export function createWatchdog(config: WatchdogConfig): Watchdog {
  const { claudePid, intervalMs, onOrphaned } = config;
  const probe = config.probe ?? ((pid: number) => process.kill(pid, 0));
  let timer: ReturnType<typeof setInterval> | null = null;
  let fired = false;

  function check(): boolean {
    try {
      probe(claudePid);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM") return true;
      return false;
    }
  }

  function tick() {
    if (fired) return;
    if (!check()) {
      fired = true;
      if (timer) clearInterval(timer);
      timer = null;
      onOrphaned();
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    check,
  };
}
