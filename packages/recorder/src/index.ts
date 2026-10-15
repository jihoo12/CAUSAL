import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, eventSchema, fingerprint, redact, validateTrace } from '@causal/trace-schema';
import type { ExecutionEvent, EventType, Payload, Json } from '@causal/trace-schema';

export interface TraceSummary { traceId: string; outcome: 'success' | 'failure' | 'error'; eventCount: number; parentTraceId: string | null }
export interface TraceStore {
  save(events: ExecutionEvent[]): void;
  load(traceId: string): ExecutionEvent[];
  list(): TraceSummary[];
  close(): void;
}
/** Immutable complete traces committed in one SQLite transaction. */
export class SqliteTraceStore implements TraceStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, parent_id TEXT, outcome TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (trace_id TEXT NOT NULL REFERENCES traces(id), sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(trace_id, sequence), UNIQUE(trace_id, event_id));`);
  }
  save(input: ExecutionEvent[]): void {
    const events = validateTrace(input);
    const start = events[0]!;
    const last = events.at(-1)!;
    const parent = start.eventType === 'run.started' ? start.payload.lineage?.parentTraceId ?? null : null;
    const outcome = last.eventType === 'run.completed' ? (last.payload.success ? 'success' : 'failure') : 'error';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO traces VALUES (?, ?, ?, ?)').run(events[0]!.traceId, parent, outcome, fingerprint(events));
      const insert = this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
      for (const e of events) insert.run(e.traceId, e.sequenceNumber, e.eventId, canonical(e));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  load(traceId: string): ExecutionEvent[] {
    const row = this.db.prepare('SELECT digest FROM traces WHERE id = ?').get(traceId);
    if (!row) throw new Error(`Unknown trace: ${traceId}`);
    const rows = this.db.prepare('SELECT body FROM events WHERE trace_id = ? ORDER BY sequence').all(traceId);
    const events = validateTrace(rows.map(r => JSON.parse(String(r.body)) as unknown));
    if (fingerprint(events) !== row.digest) throw new Error(`Stored trace integrity mismatch: ${traceId}`);
    return events;
  }
  list(): TraceSummary[] {
    return this.db.prepare(`SELECT t.id, t.parent_id, t.outcome, COUNT(e.sequence) AS count
      FROM traces t JOIN events e ON t.id = e.trace_id GROUP BY t.id ORDER BY t.rowid`).all().map(r => ({
      traceId: String(r.id), parentTraceId: r.parent_id === null ? null : String(r.parent_id),
      outcome: r.outcome as TraceSummary['outcome'], eventCount: Number(r.count),
    }));
  }
  close(): void { this.db.close(); }
}

export class Recorder {
  readonly traceId: string;
  private readonly history: ExecutionEvent[] = [];
  constructor(traceId = randomUUID(), private readonly clock: () => string = () => new Date().toISOString()) { this.traceId = traceId; }
  emit<T extends EventType>(eventType: T, payload: Payload<T>, parentEventId?: string): ExecutionEvent & { eventType: T } {
    const sequenceNumber = this.history.length;
    const event = eventSchema.parse({ schemaVersion: 1, traceId: this.traceId, eventId: `${this.traceId}:${sequenceNumber}`,
      sequenceNumber, timestamp: this.clock(), eventType, payload: redact(payload as Json),
      ...(parentEventId === undefined ? {} : { parentEventId }),
    });
    validateTrace([...this.history, event], false);
    this.history.push(event);
    return event as ExecutionEvent & {eventType: T};
  }
  events(): ExecutionEvent[] { return structuredClone(this.history); }
  finish(store?: TraceStore): ExecutionEvent[] {
    const events = validateTrace(this.events());
    store?.save(events);
    return events;
  }
}
