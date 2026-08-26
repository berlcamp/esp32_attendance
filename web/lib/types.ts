import type { FeedRow } from "./supabase";

export type RosterEntry = {
  id: string;
  name: string;
  studentNo: string | null;
  arrivedAt: string | null;
  estimated: boolean;
  late: boolean;
};

export type FeedPayload = {
  configured: boolean;
  error: string | null;
  hint?: string | null;
  now: string;
  tz: string;
  gate: { deviceId: string; lastSeen: string | null; secondsSince: number | null };
  stats: {
    present: number;
    enrolled: number;
    scansToday: number;
    unknownScans: number;
    unknownCards: string[];
    lateSync: number;
    inferredTime: number;
  };
  feed: FeedRow[];
  roster: RosterEntry[];
};
