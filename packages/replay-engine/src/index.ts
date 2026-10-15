import { canonical, docsResponseSchema, normalize, validateTrace } from '@causal/trace-schema';
import type { ExecutionEvent, Json } from '@causal/trace-schema';
import { executeAgent, runLive, verifyBoundary } from '@causal/broken-auth-agent';
import type { Intervention, Tool, ToolDriver } from '@causal/broken-auth-agent';
import type { TraceStore } from '@causal/recorder';

/** A tool-response tape; it never launches a process or writes workspace files. */
class RecordedDriver implements ToolDriver {
  private cursor = 0;
  private readonly calls: Extract<ExecutionEvent, {eventType: 'tool.called'}>[];
  private readonly results: Map<string, Extract<ExecutionEvent, {eventType: 'tool.completed'}>>;
  constructor(events: ExecutionEvent[]) {
    this.calls = events.filter(e => e.eventType === 'tool.called');
    this.results = new Map(events.filter(e => e.eventType === 'tool.completed').map(e => [e.payload.callId, e]));
  }
  perform(tool: Tool, input: Json): Json {
    const call = this.calls[this.cursor++];
    if (!call || call.payload.tool !== tool || canonical(call.payload.input) !== canonical(input)) throw new Error(`Replay diverged at tool call ${this.cursor - 1}: ${tool}`);
    const result = this.results.get(call.payload.callId);
    if (!result) throw new Error('Recorded tool response is missing');
    return structuredClone(result.payload.output);
  }
}
function checkpoint(events: ExecutionEvent[]) {
  const c = events.find(e => e.eventType === 'state.checkpoint');
  if (c?.eventType !== 'state.checkpoint') throw new Error('Required pre-documentation checkpoint is missing');
  return verifyBoundary(c.payload.snapshot);
}
export function exactReplay(input: ExecutionEvent[]) {
  const events = validateTrace(input);
  if (events.at(-1)?.eventType === 'run.failed') throw new Error('Operationally failed traces cannot be deterministically replayed by this fixture');
  const boundary = checkpoint(events);
  const applied = events.find(e => e.eventType === 'intervention.applied');
  const intervention: Intervention | undefined = applied?.eventType === 'intervention.applied' ? applied.payload : undefined;
  const replay = executeAgent(new RecordedDriver(events), { boundary, ...(intervention ? { intervention } : {}) });
  const expected = canonical(normalize(events));
  const actual = canonical(normalize(replay.events));
  if (expected !== actual) throw new Error('Replay equivalence failed: normalized events or state fingerprints differ');
  return { equivalent: true as const, mode: 'frozen-tool-reexecution' as const, eventCount: events.length,
    traceId: events[0]!.traceId, finalFingerprint: replay.finalSnapshot.fingerprint,
    guarantees: ['ordered events', 'tool identities and inputs', 'recorded outputs', 'agent decisions', 'snapshot fingerprints'],
    ignoredMetadata: ['traceId', 'eventId (topology preserved)', 'timestamp'],
    externalToolsReexecuted: false as const };
}

export function forkTrace(input: ExecutionEvent[], eventId: string, replacement: unknown, store?: TraceStore) {
  const events = validateTrace(input);
  // Verify the parent before accepting its checkpoint as a supported continuation boundary.
  exactReplay(events);
  const target = events.find(e => e.eventId === eventId);
  if (target?.eventType !== 'tool.completed' || target.payload.tool !== 'docs.lookup') {
    throw new Error(`Invalid intervention target ${eventId}: select a docs.lookup tool.completed event`);
  }
  const response = docsResponseSchema.parse(replacement);
  const boundary = checkpoint(events);
  const previous = events[target.sequenceNumber - 1];
  // The supported boundary is directly before docs completion (fork parents have an intervention here).
  const checkpointBefore = events.slice(0, target.sequenceNumber).findLast(e => e.eventType === 'state.checkpoint');
  if (!previous || checkpointBefore?.eventType !== 'state.checkpoint' || checkpointBefore.parentEventId !== target.parentEventId) {
    throw new Error('Target has no compatible checkpoint at its pending tool call');
  }
  if (canonical(response) === canonical(target.payload.output)) throw new Error('Replacement must differ from the original tool response');
  const intervention: Intervention = { parentTraceId: events[0]!.traceId, targetEventId: eventId,
    original: target.payload.output, replacement: response, checkpointFingerprint: boundary.fingerprint };
  return runLive({ boundary, intervention, ...(store ? { store } : {}) });
}
