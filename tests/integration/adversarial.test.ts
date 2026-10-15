import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, fingerprint, importJsonl, exportJsonl, validateTrace } from '../../packages/trace-schema/dist/index.js';
import type { ExecutionEvent } from '../../packages/trace-schema/dist/index.js';
import { Recorder, SqliteTraceStore } from '../../packages/recorder/dist/index.js';
import { correctedDocs, fixtureFiles, generateSource, initialSnapshot, LiveFixtureDriver, runLive } from '../../examples/broken-auth-agent/dist/index.js';
import { exactReplay, forkTrace } from '../../packages/replay-engine/dist/index.js';
import { compare, experiment } from '../../packages/experiment-engine/dist/index.js';

const cleanup: string[] = [];
function temp(): string { const p = mkdtempSync(join(tmpdir(), 'causal-adversarial-')); cleanup.push(p); return p; }
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });
function target(events: ExecutionEvent[]): string { return events.find(e => e.eventType === 'tool.completed' && e.payload.tool === 'docs.lookup')!.eventId; }
function started(recorder: Recorder) {
  return recorder.emit('run.started', { agent: 'broken-auth-v1', config: initialSnapshot().config,
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch } });
}

describe('adversarial data integrity', () => {
  it('cannot mutate recorder history through a returned event', () => {
    const recorder = new Recorder();
    const event = started(recorder);
    event.payload.runtime.node = 'forged';
    expect(recorder.events()[0]!.payload).toMatchObject({ runtime: { node: process.versions.node } });
  });
  it('rejects JSON keys that the schema parser would silently omit from fingerprints', () => {
    const data: unknown = JSON.parse('{"__proto__":{"hidden":"value"}}');
    expect(() => canonical(data)).toThrow(/Unsafe JSON key/);
    expect(() => fingerprint({ nested: data })).toThrow(/Unsafe JSON key/);
  });
  it('rejects a fork using its own parent trace ID even when normalized replay matches', () => {
    const original = runLive().events;
    const fork = forkTrace(original, target(original), correctedDocs).events;
    const forged = fork.map(e => ({ ...e, traceId: original[0]!.traceId }));
    expect(() => compare(original, forged)).toThrow(/own parent|distinct/);
  });
  it('rejects fabricated no-op intervention histories', () => {
    const original = runLive().events;
    expect(() => runLive({ intervention: {
      parentTraceId: original[0]!.traceId, targetEventId: target(original),
      original: { api: 'auth.loginLegacy()' }, replacement: { api: 'auth.loginLegacy()' }, checkpointFingerprint: initialSnapshot().fingerprint,
    } })).toThrow(/differ/);
  });
  it('preserves a handled failure before the intervention has been applied', () => {
    const original = runLive().events;
    const store = new SqliteTraceStore(':memory:');
    try {
      expect(() => runLive({ store, intervention: { parentTraceId: original[0]!.traceId, targetEventId: target(original),
        original: { api: 'auth.loginLegacy()' }, replacement: correctedDocs, checkpointFingerprint: '0'.repeat(64) } })).toThrow(/checkpoint mismatch/);
      expect(store.list()).toHaveLength(1);
      const failed = store.load(store.list()[0]!.traceId);
      expect(failed.at(-1)?.eventType).toBe('run.failed');
      expect(failed.some(e => e.eventType === 'intervention.applied')).toBe(false);
    } finally { store.close(); }
  });
  it('does not permit an errored tool in a normally completed trace', () => {
    const events = runLive().events;
    const result = events.find(e => e.eventType === 'tool.completed');
    if (result?.eventType !== 'tool.completed') throw new Error('Missing fixture result');
    result.payload.output = null; result.payload.error = { name: 'Error', message: 'unavailable' };
    expect(() => validateTrace(events)).toThrow(/errored tool/);
  });
  it.each(['outcome', 'parent_id', 'event_id', 'sequence'] as const)('detects corrupt SQLite %s metadata instead of trusting the JSON digest alone', field => {
    const path = join(temp(), 'store.sqlite');
    const events = runLive().events;
    const store = new SqliteTraceStore(path);
    try {
      store.save(events);
      const raw = new DatabaseSync(path);
      try {
        if (field === 'outcome') raw.exec("UPDATE traces SET outcome = 'success'");
        if (field === 'parent_id') raw.exec("UPDATE traces SET parent_id = 'wrong'");
        if (field === 'event_id') raw.exec("UPDATE events SET event_id = 'wrong' WHERE sequence = 0");
        if (field === 'sequence') raw.exec('UPDATE events SET sequence = 99 WHERE sequence = 11');
      } finally { raw.close(); }
      expect(() => store.load(events[0]!.traceId)).toThrow(/integrity|metadata/);
      expect(() => store.list()).toThrow(/integrity|metadata/);
    } finally { store.close(); }
  });
  it('isolates success-predicate mutations from original histories, persisted trials, and comparison evidence', () => {
    const original = runLive().events;
    const before = canonical(original);
    const store = new SqliteTraceStore(':memory:');
    try {
      const result = experiment({ original, targetEventId: target(original), replacement: correctedDocs, trials: 1, store,
        predicateName: 'hostile-but-boolean', successPredicate: events => { events.length = 0; return true; } });
      expect(canonical(original)).toBe(before);
      expect(result.trials[0]!.comparison.counterfactual.success).toBe(true);
      expect(store.list()).toHaveLength(1);
    } finally { store.close(); }
  });
});

describe('live workspace fidelity', () => {
  it('rejects a symlink even if its target has exactly the expected source bytes and inventory is unchanged', () => {
    const driver = new LiveFixtureDriver(initialSnapshot());
    const source = generateSource(correctedDocs);
    try {
      driver.perform('workspace.write', { path: 'solution.mjs', contents: source });
      const target = join(temp(), 'same-bytes.mjs'); writeFileSync(target, source);
      unlinkSync(join(driver.workspace, 'solution.mjs'));
      symlinkSync(target, join(driver.workspace, 'solution.mjs'));
      const spawn = vi.spyOn(childProcess, 'spawnSync'); syncBuiltinESMExports();
      expect(() => driver.perform('tests.run', { suite: 'authentication' })).toThrow(/Workspace integrity/);
      expect(spawn).not.toHaveBeenCalled();
    } finally { driver.close(); }
  });
  it('rejects post-test disk drift rather than publishing an expected but false final snapshot', () => {
    const realSpawn = childProcess.spawnSync;
    let workspace = '';
    vi.spyOn(childProcess, 'spawnSync').mockImplementation((file, args, options) => {
      workspace = String(options!.cwd);
      const result = realSpawn(file, args!, options!);
      writeFileSync(join(workspace, 'solution.mjs'), '// changed after the real test\n');
      return result;
    });
    syncBuiltinESMExports();
    const store = new SqliteTraceStore(':memory:');
    try {
      expect(() => runLive({ store })).toThrow(/Workspace integrity/);
      const failed = store.load(store.list()[0]!.traceId);
      expect(failed.at(-1)?.eventType).toBe('run.failed');
      expect(failed.some(e => e.eventType === 'run.completed')).toBe(false);
      expect(existsSync(workspace)).toBe(false);
    } finally { store.close(); }
  });
  it.each(['test', 'library', 'solution', 'extra', 'symlink'] as const)('rejects %s drift before executing any changed workspace', drift => {
    const driver = new LiveFixtureDriver(initialSnapshot());
    const source = generateSource(correctedDocs);
    try {
      driver.perform('workspace.write', { path: 'solution.mjs', contents: source });
      if (drift === 'test') writeFileSync(join(driver.workspace, 'test.mjs'), "console.log('PASS authentication');\n");
      if (drift === 'library') writeFileSync(join(driver.workspace, 'auth.mjs'), fixtureFiles['auth.mjs'] + '\n');
      if (drift === 'solution') writeFileSync(join(driver.workspace, 'solution.mjs'), source + '\n');
      if (drift === 'extra') writeFileSync(join(driver.workspace, 'unrecorded.mjs'), '// extra file');
      if (drift === 'symlink') {
        writeFileSync(join(driver.workspace, 'other.mjs'), source);
        unlinkSync(join(driver.workspace, 'solution.mjs'));
        symlinkSync('other.mjs', join(driver.workspace, 'solution.mjs'));
      }
      const spawn = vi.spyOn(childProcess, 'spawnSync'); syncBuiltinESMExports();
      expect(() => driver.perform('tests.run', { suite: 'authentication' })).toThrow(/Workspace integrity/);
      expect(spawn).not.toHaveBeenCalled();
    } finally { driver.close(); }
  });
  it('keeps compiled-in fixture trust anchors immutable', () => {
    expect(Object.isFrozen(fixtureFiles)).toBe(true);
    expect(Object.isFrozen(correctedDocs)).toBe(true);
  });
  it('executes different source bytes in separate equivalent workspaces, recomputes actions, and strips host environment', () => {
    const observed: { cwd: string; files: Record<string, string>; args: readonly string[]; env: NodeJS.ProcessEnv; timeout: number | undefined; maxBuffer: number | undefined }[] = [];
    const realSpawn = childProcess.spawnSync;
    const spy = vi.spyOn(childProcess, 'spawnSync').mockImplementation((file, args, options) => {
      const cwd = String(options!.cwd);
      observed.push({ cwd, files: Object.fromEntries(readdirSync(cwd).map(name => [name, readFileSync(join(cwd, name), 'utf8')])),
        args: args as readonly string[], env: options!.env!, timeout: options!.timeout, maxBuffer: options!.maxBuffer });
      return realSpawn(file, args!, options!);
    });
    syncBuiltinESMExports();
    const original = runLive(); const frozenParent = canonical(original.events);
    const liveActions = vi.spyOn(LiveFixtureDriver.prototype, 'perform');
    const fork = forkTrace(original.events, target(original.events), correctedDocs);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(liveActions.mock.calls.map(([tool]) => tool)).toEqual(['docs.lookup', 'workspace.write', 'tests.run']);
    expect(observed[0]!.files['solution.mjs']).toBe(original.source);
    expect(observed[1]!.files['solution.mjs']).toBe(fork.source);
    expect(observed[0]!.files['solution.mjs']).not.toBe(observed[1]!.files['solution.mjs']);
    for (const [i, run] of [original, fork].entries()) {
      const observation = observed[i]!;
      expect(observation.files['auth.mjs']).toBe(fixtureFiles['auth.mjs']);
      expect(observation.files['test.mjs']).toBe(fixtureFiles['test.mjs']);
      expect(observation.env).toEqual({ TZ: 'UTC', LANG: 'C', HOME: observation.cwd });
      expect(observation.args).toContain('--permission');
      expect(observation.timeout).toBe(5000);
      expect(observation.maxBuffer).toBe(64 * 1024);
      expect(existsSync(run.workspace)).toBe(false);
      expect(observation.cwd).toBe(run.workspace);
    }
    expect(observed[0]!.cwd).not.toBe(observed[1]!.cwd);
    expect(original.test.exitCode).toBe(1); expect(fork.test.exitCode).toBe(0);
    expect(canonical(original.events)).toBe(frozenParent);
    const { 'solution.mjs': _a, ...first } = observed[0]!.files;
    const { 'solution.mjs': _b, ...second } = observed[1]!.files;
    expect(first).toEqual(second);
  });
});

describe('replay boundaries and limits', () => {
  it('treats changed runtime metadata as an explicit supported-environment mismatch', () => {
    const events = runLive().events;
    const start = events[0]!;
    if (start.eventType === 'run.started') start.payload.runtime.node = '24.0.0-unverified';
    expect(() => exactReplay(events)).toThrow(/equivalence/);
  });
  it('ignores fork-local IDs and timestamps but preserves parent references and state', () => {
    const original = runLive().events;
    const fork = forkTrace(original, target(original), correctedDocs).events;
    const ids = new Map(fork.map(e => [e.eventId, `new-${e.sequenceNumber}`]));
    const changed = fork.map(e => ({ ...e, eventId: ids.get(e.eventId)!, timestamp: '2020-01-01T00:00:00.000Z',
      ...(e.parentEventId ? { parentEventId: ids.get(e.parentEventId)! } : {}) }));
    expect(exactReplay(changed).equivalent).toBe(true);
    expect(compare(original, changed).counterfactual.success).toBe(true);
  });
  it('rejects an intervention label whose replacement was not observed downstream', () => {
    const original = runLive().events;
    const fork = forkTrace(original, target(original), correctedDocs).events;
    const result = fork.find(e => e.eventType === 'tool.completed' && e.payload.tool === 'docs.lookup');
    if (result?.eventType !== 'tool.completed') throw new Error('Missing observation');
    result.payload.output = { api: 'auth.loginLegacy()' };
    expect(() => exactReplay(fork)).toThrow(/did not apply/);
  });
  it('rejects stale final snapshots even when their hashes are internally consistent', () => {
    const original = runLive().events;
    const fork = forkTrace(original, target(original), correctedDocs).events;
    const oldCheckpoint = original.findLast(e => e.eventType === 'state.checkpoint')!;
    const checkpoint = fork.findLast(e => e.eventType === 'state.checkpoint')!;
    if (oldCheckpoint.eventType !== 'state.checkpoint' || checkpoint.eventType !== 'state.checkpoint') throw new Error('Missing snapshot');
    checkpoint.payload = structuredClone(oldCheckpoint.payload);
    const end = fork.at(-1)!;
    if (end.eventType === 'run.completed') end.payload.finalFingerprint = checkpoint.payload.snapshot.fingerprint;
    expect(() => exactReplay(fork)).toThrow(/equivalence/);
  });
  it('documents that a self-consistent fabricated test tape is not authenticated live evidence', () => {
    const events = runLive().events;
    const fake = { passed: true, exitCode: 0, stdout: 'PASS authentication\n', stderr: '' };
    for (const e of events) {
      if (e.eventType === 'tool.completed' && e.payload.tool === 'tests.run') e.payload.output = fake;
      if (e.eventType === 'test.completed') e.payload = fake;
      if (e.eventType === 'run.completed') e.payload.success = true;
    }
    expect(exactReplay(events)).toMatchObject({ equivalent: true, externalToolsReexecuted: false });
    expect(events.find(e => e.eventType === 'agent.decision')?.payload).toMatchObject({ api: 'auth.loginLegacy()' });
  });
  it('keeps portable imports stable across database and temporary directory paths', () => {
    const events = runLive().events;
    const imported = importJsonl(exportJsonl(events));
    const store = new SqliteTraceStore(join(temp(), 'elsewhere.sqlite'));
    try { store.save(imported); expect(exactReplay(store.load(imported[0]!.traceId)).equivalent).toBe(true); }
    finally { store.close(); }
  });
});

it('CLI exclusive exports reject existing files and symlinks without modifying their targets', () => {
  const cwd = temp(); const cli = resolve('packages/cli/dist/index.js');
  const env = { TZ: 'UTC', LANG: 'C', HOME: cwd };
  const recorded = JSON.parse(execFileSync(process.execPath, [cli, 'record', '--json'], { cwd, env, timeout: 5000, encoding: 'utf8' })) as {traceId: string};
  const existing = join(cwd, 'user.txt'); const link = join(cwd, 'link.jsonl');
  writeFileSync(existing, 'keep me'); symlinkSync(existing, link);
  for (const path of [existing, link]) {
    const result = childProcess.spawnSync(process.execPath, [cli, 'export', recorded.traceId, '--out', path, '--json'], { cwd, env, timeout: 5000, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(JSON.parse(result.stderr).error).toMatch(/EEXIST/);
  }
  expect(readFileSync(existing, 'utf8')).toBe('keep me'); expect(lstatSync(link).isSymbolicLink()).toBe(true);
});
