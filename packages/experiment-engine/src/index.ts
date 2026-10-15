import { canonical, validateTrace } from '@causal/trace-schema';
import type { ExecutionEvent, Json } from '@causal/trace-schema';
import { exactReplay, forkTrace } from '@causal/replay-engine';
import type { TraceStore } from '@causal/recorder';

export interface Outcome { success: boolean; exitCode: number; stdout: string; source: string; fingerprint: string }
export function outcome(input: ExecutionEvent[]): Outcome {
  const events = validateTrace(input);
  const test = events.find(e => e.eventType === 'test.completed');
  const final = events.findLast(e => e.eventType === 'state.checkpoint');
  const terminal = events.at(-1);
  if (test?.eventType !== 'test.completed' || final?.eventType !== 'state.checkpoint' || terminal?.eventType !== 'run.completed') throw new Error('Trace has no completed experimental outcome');
  if (terminal.payload.success !== test.payload.passed || terminal.payload.finalFingerprint !== final.payload.snapshot.fingerprint) throw new Error('Inconsistent terminal outcome');
  return { success: test.payload.passed, exitCode: test.payload.exitCode, stdout: test.payload.stdout,
    source: final.payload.snapshot.files['solution.mjs'] ?? '', fingerprint: final.payload.snapshot.fingerprint };
}
export const limitations = [
  'This is a controlled deterministic fixture, not a general-purpose coding agent.',
  'Identical deterministic trials are reproducibility checks, not independent statistical evidence.',
  'The contrast supports this intervention under the fixed fixture; it does not establish real-world causal attribution.',
  'External side effects, stochastic LLMs and arbitrary environment restoration are not supported.',
];
export function compare(originalInput: ExecutionEvent[], forkInput: ExecutionEvent[]) {
  const original = validateTrace(originalInput);
  const fork = validateTrace(forkInput);
  exactReplay(original);
  exactReplay(fork);
  const applied = fork.find(e => e.eventType === 'intervention.applied');
  if (applied?.eventType !== 'intervention.applied' || applied.payload.parentTraceId !== original[0]!.traceId) throw new Error('Fork does not reference the supplied parent trace');
  const target = original.find(e => e.eventId === applied.payload.targetEventId);
  if (target?.eventType !== 'tool.completed' || target.payload.tool !== 'docs.lookup' || canonical(target.payload.output) !== canonical(applied.payload.original)) throw new Error('Intervention does not match parent tool output');
  const before = original.find(e => e.eventType === 'state.checkpoint');
  const after = fork.find(e => e.eventType === 'state.checkpoint');
  if (before?.eventType !== 'state.checkpoint' || after?.eventType !== 'state.checkpoint' ||
    before.payload.snapshot.fingerprint !== after.payload.snapshot.fingerprint || before.payload.snapshot.fingerprint !== applied.payload.checkpointFingerprint) throw new Error('Initial fixture states are not equivalent');
  const a = outcome(original); const b = outcome(fork);
  const decision = (events: ExecutionEvent[]) => events.filter(e => e.eventType === 'agent.decision').map(e => e.payload);
  return { originalTraceId: original[0]!.traceId, forkTraceId: fork[0]!.traceId, interventionEventId: applied.eventId,
    intervention: applied.payload, original: a, counterfactual: b,
    successRateDifference: Number(b.success) - Number(a.success),
    differences: { sourceChanged: a.source !== b.source, finalStateChanged: a.fingerprint !== b.fingerprint,
      originalDecisions: decision(original), counterfactualDecisions: decision(fork),
      files: [...new Set([...Object.keys(before.payload.snapshot.files), 'solution.mjs'])].filter(name => {
        const af = original.findLast(e => e.eventType === 'state.checkpoint');
        const bf = fork.findLast(e => e.eventType === 'state.checkpoint');
        return af?.eventType === 'state.checkpoint' && bf?.eventType === 'state.checkpoint' && af.payload.snapshot.files[name] !== bf.payload.snapshot.files[name];
      }) }, limitations };
}
export interface ExperimentOptions {
  original: ExecutionEvent[]; targetEventId: string; replacement: Json; trials: number;
  successPredicate?: (events: ExecutionEvent[]) => boolean;
  predicateName?: string;
  store?: TraceStore;
}
export function experiment(options: ExperimentOptions) {
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 100) throw new Error('Trials must be an integer between 1 and 100');
  if (options.successPredicate && !options.predicateName) throw new Error('A custom success predicate requires a predicateName');
  const original = validateTrace(options.original);
  exactReplay(original);
  const predicate = options.successPredicate ?? ((events: ExecutionEvent[]) => outcome(events).success);
  const success = (events: ExecutionEvent[]): boolean => {
    const value = predicate(structuredClone(events));
    if (typeof value !== 'boolean') throw new Error('Success predicate must return a boolean');
    return value;
  };
  const originalSuccess = success(original);
  const trials = Array.from({ length: options.trials }, (_, index) => {
    const startedAt = new Date().toISOString();
    const run = forkTrace(original, options.targetEventId, options.replacement, options.store);
    return { index, startedAt, completedAt: new Date().toISOString(), success: success(run.events),
      traceId: run.events[0]!.traceId, comparison: compare(original, run.events) };
  });
  const successes = trials.filter(t => t.success).length;
  return { schemaVersion: 1, predicate: options.predicateName ?? 'real-authentication-test-passes',
    original: outcome(original), originalSuccess, trials, successCounts: { successes, failures: trials.length - successes },
    counterfactualSuccessRate: successes / trials.length,
    successRateDifference: successes / trials.length - Number(originalSuccess),
    independentStatisticalEvidence: false, limitations };
}
export function humanComparison(report: ReturnType<typeof compare>): string {
  return [
    `Original ${report.originalTraceId}: ${report.original.success ? 'PASS' : 'FAIL'} (exit ${report.original.exitCode})`,
    report.original.stdout.trim(),
    `Counterfactual ${report.forkTraceId}: ${report.counterfactual.success ? 'PASS' : 'FAIL'} (exit ${report.counterfactual.exitCode})`,
    report.counterfactual.stdout.trim(),
    `Intervention ${report.interventionEventId}: ${canonical(report.intervention.original)} -> ${canonical(report.intervention.replacement)}`,
    `Generated source changed: ${report.differences.sourceChanged}; final state changed: ${report.differences.finalStateChanged}`,
    `Success-rate difference: ${report.successRateDifference >= 0 ? '+' : ''}${report.successRateDifference} (deterministic fixture)`,
    ...report.limitations,
  ].join('\n');
}
