import { execFileSync } from 'node:child_process';

type Run = (cmd: string, args: string[]) => string;

const defaultRun: Run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 });

// clock_synced on each scan. NTP makes it nearly always true on Ubuntu, but an
// unsynced clock is recorded as false rather than dropping the scan, so the
// parent-facing caveat survives. Off Linux (the Mac) it is assumed true.
export function createClockProbe(
  platform: string = process.platform,
  run: Run = defaultRun,
  cacheMs = 60_000,
): (nowMs?: number) => boolean {
  let cached: boolean | null = null;
  let at = -Infinity;
  return (nowMs = Date.now()) => {
    if (platform !== 'linux') return true;
    if (cached !== null && nowMs - at < cacheMs) return cached;
    try {
      cached = run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']).trim() === 'yes';
    } catch {
      cached = false;
    }
    at = nowMs;
    return cached;
  };
}
