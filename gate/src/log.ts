// Every module logs through this so tests can capture lines. In production it
// is console.log, and journald adds the timestamps.
export type Log = (line: string) => void;
