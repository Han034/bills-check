export const MINUTE = 60_000;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const floorMinute = (t: number) => Math.floor(t / MINUTE) * MINUTE;

/** Local midnight of the day containing t (the server's TZ). */
export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A clock that only moves when told to: the demo and the tests run on it. */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
  set(t: number) { this.t = t; }
}
