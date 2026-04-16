// server/health.ts
import type { HeartbeatEvent } from "./events";

export interface HeartbeatConfig {
  intervalMs: number;
  getEventsSent: () => number;
  onHeartbeat: (event: HeartbeatEvent) => void;
}

export interface HeartbeatEmitter {
  start: () => void;
  stop: () => void;
  getUptimeSeconds: () => number;
}

export function createHeartbeatEmitter(
  config: HeartbeatConfig
): HeartbeatEmitter {
  const { intervalMs, getEventsSent, onHeartbeat } = config;
  let timer: ReturnType<typeof setInterval> | null = null;
  const startTime = Date.now();

  function emit() {
    const event: HeartbeatEvent = {
      type: "heartbeat",
      seq: 0,
      server_uptime_s: Math.floor((Date.now() - startTime) / 1000),
      events_sent: getEventsSent(),
      timestamp: Date.now(),
    };
    onHeartbeat(event);
  }

  return {
    start() {
      timer = setInterval(emit, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    getUptimeSeconds() {
      return Math.floor((Date.now() - startTime) / 1000);
    },
  };
}
