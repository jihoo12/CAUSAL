import { createHash } from 'node:crypto';
import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
// Zod's record parser omits __proto__. Reject it before parsing rather than
// hashing a different value from the one supplied on the wire.
function safeRecord<S extends z.ZodTypeAny>(value: S) {
  return z.preprocess((input, ctx) => {
    if (input !== null && typeof input === 'object' && Object.hasOwn(input, '__proto__')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsafe JSON key: __proto__' });
      return z.NEVER;
    }
    return input;
  }, z.record(value));
}
export const jsonSchema: z.ZodType<Json, z.ZodTypeDef, unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), safeRecord(jsonSchema),
]));
export function canonical(value: unknown): string {
  const parsed = jsonSchema.parse(value);
  function encode(v: Json): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode(v[k]!)}`).join(',')}}`;
  }
  return encode(parsed);
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const docsResponseSchema = z.object({ api: z.enum(['auth.loginLegacy()', 'auth.login()']) }).strict();
export type DocsResponse = z.infer<typeof docsResponseSchema>;
export const snapshotBodySchema = z.object({
  agent: z.object({ phase: z.enum(['awaiting-documentation', 'completed']), task: z.literal('implement-auth') }).strict(),
  files: safeRecord(z.string()),
  toolState: z.object({ lookupVersion: z.literal('misleading-v1') }).strict(),
  config: z.object({ fixtureVersion: z.literal(1), nodeMajor: z.literal(24) }).strict(),
}).strict();
export const snapshotSchema = snapshotBodySchema.extend({ fingerprint: hash });
export type Snapshot = z.infer<typeof snapshotSchema>;
export function snapshot(body: z.infer<typeof snapshotBodySchema>): Snapshot {
  return { ...snapshotBodySchema.parse(body), fingerprint: fingerprint(body) };
}
export function verifySnapshot(input: unknown): Snapshot {
  const s = snapshotSchema.parse(input);
  const { fingerprint: expected, ...body } = s;
  if (fingerprint(body) !== expected) throw new Error('Snapshot integrity mismatch');
  for (const name of Object.keys(s.files)) {
    if (!/^[a-z][a-z0-9-]*\.mjs$/.test(name)) throw new Error(`Unsafe snapshot path: ${name}`);
  }
  return s;
}
export const testResultSchema = z.object({
  passed: z.boolean(), exitCode: z.number().int(), stdout: z.string(), stderr: z.string(),
}).strict().refine(r => r.passed === (r.exitCode === 0), 'Test status and exit code disagree');
export type TestResult = z.infer<typeof testResultSchema>;
const base = {
  schemaVersion: z.literal(1), traceId: z.string().uuid(), eventId: z.string().min(1),
  sequenceNumber: z.number().int().nonnegative(), timestamp: z.string().datetime(),
  parentEventId: z.string().min(1).optional(),
};
const lineage = z.object({ parentTraceId: z.string().uuid(), targetEventId: z.string(), checkpointFingerprint: hash }).strict();
function event<T extends string, S extends z.ZodTypeAny>(eventType: T, payload: S) {
  return z.object({ ...base, eventType: z.literal(eventType), payload }).strict();
}
export const eventSchema = z.discriminatedUnion('eventType', [
  event('run.started', z.object({ agent: z.literal('broken-auth-v1'), config: snapshotBodySchema.shape.config, runtime: z.object({ node: z.string(), platform: z.string(), arch: z.string() }).strict(), lineage: lineage.optional() }).strict()),
  event('agent.decision', z.object({ api: docsResponseSchema.shape.api, sourceHash: hash }).strict()),
  event('tool.called', z.object({ callId: z.string(), tool: z.enum(['docs.lookup', 'workspace.write', 'tests.run']), input: jsonSchema,
    metadata: z.object({ executor: z.literal('fixture-v1') }).strict() }).strict()),
  event('tool.completed', z.object({ callId: z.string(), tool: z.enum(['docs.lookup', 'workspace.write', 'tests.run']), output: jsonSchema, error: z.object({ name: z.string(), message: z.string() }).strict().optional() }).strict().refine(p => !p.error || p.output === null, 'An errored tool has null output')),
  event('state.checkpoint', z.object({ snapshot: snapshotSchema }).strict()),
  event('intervention.applied', z.object({ parentTraceId: z.string().uuid(), targetEventId: z.string(), original: jsonSchema, replacement: docsResponseSchema, checkpointFingerprint: hash }).strict()),
  event('test.completed', testResultSchema),
  event('run.completed', z.object({ success: z.boolean(), finalFingerprint: hash }).strict()),
  event('run.failed', z.object({ message: z.string() }).strict()),
]);
export type ExecutionEvent = z.infer<typeof eventSchema>;
export type EventType = ExecutionEvent['eventType'];
export type Payload<T extends EventType> = Extract<ExecutionEvent, {eventType: T}>['payload'];

/** Explicit recursive field filtering. Free-text secrets require caller-side filtering. */
export function redact(value: Json): Json {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
      /password|secret|token|authorization|cookie|api[-_]?key/i.test(key) ? '[REDACTED]' : redact(v)]));
  }
  return value;
}

export function validateTrace(input: unknown, complete = true): ExecutionEvent[] {
  const events = z.array(eventSchema).min(1).parse(input);
  const ids = new Map<string, ExecutionEvent>();
  const pending = new Map<string, Extract<ExecutionEvent, {eventType: 'tool.called'}>>();
  const calls = new Set<string>();
  let terminal = false;
  let toolErrored = false;
  for (const [i, e] of events.entries()) {
    if (e.sequenceNumber !== i) throw new Error(`Invalid ordering at sequence ${i}`);
    if (e.traceId !== events[0]!.traceId) throw new Error('Mixed trace IDs');
    if (ids.has(e.eventId)) throw new Error(`Duplicate event ID: ${e.eventId}`);
    if (i === 0 && e.eventType !== 'run.started') throw new Error('Trace must begin with run.started');
    if (i > 0 && e.eventType === 'run.started') throw new Error('Repeated run.started');
    if (terminal) throw new Error('Events after terminal event');
    if (e.parentEventId && !ids.has(e.parentEventId)) throw new Error('Parent must precede child');
    if (e.eventType === 'tool.called') {
      if (calls.has(e.payload.callId)) throw new Error('Duplicate call ID');
      calls.add(e.payload.callId); pending.set(e.payload.callId, e);
    }
    if (e.eventType === 'tool.completed') {
      const call = pending.get(e.payload.callId);
      if (!call || call.payload.tool !== e.payload.tool || e.parentEventId !== call.eventId) throw new Error('Unmatched tool result');
      pending.delete(e.payload.callId);
      if (e.payload.error) toolErrored = true;
    }
    if (e.eventType === 'intervention.applied' && canonical(e.payload.original) === canonical(e.payload.replacement)) {
      throw new Error('Replacement must differ from the original tool response');
    }
    if (e.eventType === 'state.checkpoint') verifySnapshot(e.payload.snapshot);
    if (e.eventType === 'run.completed' && toolErrored) throw new Error('Normal completion after an errored tool');
    if (e.eventType === 'run.completed' || e.eventType === 'run.failed') terminal = true;
    ids.set(e.eventId, e);
  }
  if (complete && (!terminal || (events.at(-1)!.eventType === 'run.completed' && pending.size))) {
    throw new Error('Incomplete trace or pending tool calls');
  }
  const start = events[0]!;
  if (start.eventType === 'run.started') {
    const interventions = events.filter(e => e.eventType === 'intervention.applied');
    if (start.payload.lineage) {
      const l = start.payload.lineage;
      if (l.parentTraceId === start.traceId) throw new Error('A trace cannot be its own parent; fork IDs must be distinct');
      const intervention = interventions[0];
      // A handled operational failure can stop before the intervention boundary.
      if ((complete && events.at(-1)!.eventType === 'run.completed' && interventions.length !== 1) || interventions.length > 1) throw new Error('Fork requires exactly one intervention');
      if (intervention?.eventType === 'intervention.applied') {
        const p = intervention.payload;
        if (p.parentTraceId !== l.parentTraceId || p.targetEventId !== l.targetEventId || p.checkpointFingerprint !== l.checkpointFingerprint) throw new Error('Inconsistent intervention lineage');
      }
    } else if (interventions.length) throw new Error('Intervention without parent lineage');
  }
  return events;
}
export function exportJsonl(events: ExecutionEvent[]): string {
  return validateTrace(events).map(e => JSON.stringify(e)).join('\n') + '\n';
}
export function importJsonl(data: string): ExecutionEvent[] {
  const lines = data.trimEnd().split('\n');
  try { return validateTrace(lines.map(line => JSON.parse(line) as unknown)); }
  catch (error) { throw new Error(`Invalid JSONL trace: ${error instanceof Error ? error.message : String(error)}`); }
}
/** IDs and wall-clock timestamps are metadata; parent topology remains significant. */
export function normalize(events: ExecutionEvent[]): Json {
  const valid = validateTrace(events);
  const ids = new Map(valid.map(e => [e.eventId, e.sequenceNumber]));
  return valid.map(e => ({ sequenceNumber: e.sequenceNumber, eventType: e.eventType,
    parent: e.parentEventId ? ids.get(e.parentEventId)! : null, payload: e.payload as Json }));
}
