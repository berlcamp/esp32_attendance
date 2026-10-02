import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timed out after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function tmpPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'gate-')), name);
}
