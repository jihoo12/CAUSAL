import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, docsResponseSchema, fingerprint, snapshot, testResultSchema, verifySnapshot } from '@causal/trace-schema';
import type { DocsResponse, ExecutionEvent, Json, Snapshot, TestResult } from '@causal/trace-schema';
import { Recorder } from '@causal/recorder';
import type { TraceStore } from '@causal/recorder';

export const misleadingDocs = Object.freeze<DocsResponse>({ api: 'auth.loginLegacy()' });
export const correctedDocs = Object.freeze<DocsResponse>({ api: 'auth.login()' });
// These are trusted fixture bytes, never loaded from an imported trace or repository.
export const fixtureFiles = Object.freeze({
  'auth.mjs': `export const auth = Object.freeze({ login: () => 'session:alice' });\n`,
  'test.mjs': `import assert from 'node:assert/strict';
import { authenticate } from './solution.mjs';
try {
  assert.equal(authenticate(), 'session:alice');
  console.log('PASS authentication');
} catch (error) {
  console.log('FAIL ' + error.name + ': ' + error.message);
  process.exitCode = 1;
}
`,
});
export function initialSnapshot(): Snapshot {
  return snapshot({ agent: { phase: 'awaiting-documentation', task: 'implement-auth' },
    files: fixtureFiles, toolState: { lookupVersion: 'misleading-v1' }, config: { fixtureVersion: 1, nodeMajor: 24 } });
}
export function verifyBoundary(input: unknown): Snapshot {
  const s = verifySnapshot(input);
  if (canonical(s) !== canonical(initialSnapshot())) throw new Error('Unsupported checkpoint: expected the trusted pre-documentation fixture state');
  return s;
}
export function generateSource(response: DocsResponse): string {
  const { api } = docsResponseSchema.parse(response);
  return `import { auth } from './auth.mjs';\nexport function authenticate() { return ${api}; }\n`;
}
export type Tool = 'docs.lookup' | 'workspace.write' | 'tests.run';
export interface ToolDriver {
  perform(tool: Tool, input: Json): Json;
}
/** Only this driver executes processes; its inputs are constrained to trusted templates. */
export class LiveFixtureDriver implements ToolDriver {
  readonly workspace: string;
  private source: string | undefined;
  private readonly response: DocsResponse;
  constructor(boundary: Snapshot, response: DocsResponse = misleadingDocs) {
    verifyBoundary(boundary);
    this.response = docsResponseSchema.parse(response);
    if (process.versions.node.split('.')[0] !== '24') throw new Error('Fixture requires Node.js 24 for a stable execution environment');
    this.workspace = mkdtempSync(join(tmpdir(), 'causal-fixture-'));
    try {
      for (const [name, contents] of Object.entries(fixtureFiles)) writeFileSync(join(this.workspace, name), contents, { mode: 0o600, flag: 'wx' });
      const restored = Object.fromEntries(Object.keys(fixtureFiles).map(name => [name, readFileSync(join(this.workspace, name), 'utf8')]));
      if (fingerprint(restored) !== fingerprint(boundary.files)) throw new Error('Restored workspace does not match checkpoint');
      this.verifyWorkspace();
    } catch (error) { this.close(); throw error; }
  }
  perform(tool: Tool, input: Json): Json {
    this.verifyWorkspace();
    switch (tool) {
      case 'docs.lookup': {
        if (canonical(input) !== canonical({ topic: 'authentication' })) throw new Error('Unsupported documentation request');
        return docsResponseSchema.parse(this.response);
      }
      case 'workspace.write': {
        if (!input || Array.isArray(input) || typeof input !== 'object' || input.path !== 'solution.mjs' ||
          ![generateSource(misleadingDocs), generateSource(correctedDocs)].includes(String(input.contents))) throw new Error('Only trusted solution templates may be executed');
        writeFileSync(join(this.workspace, 'solution.mjs'), String(input.contents), { mode: 0o600, flag: 'wx' });
        this.source = String(input.contents);
        this.verifyWorkspace();
        return { path: 'solution.mjs', contentHash: fingerprint(readFileSync(join(this.workspace, 'solution.mjs'), 'utf8')) };
      }
      case 'tests.run': {
        if (!this.source || canonical(input) !== canonical({ suite: 'authentication' })) throw new Error('Unsupported test request');
        const result = this.runTest();
        this.verifyWorkspace();
        return result as unknown as Json;
      }
    }
  }
  private verifyWorkspace(): void {
    const expected: Record<string, string> = { ...fixtureFiles, ...(this.source === undefined ? {} : { 'solution.mjs': this.source }) };
    try {
      const root = lstatSync(this.workspace);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Workspace root is not a directory');
      if (canonical(readdirSync(this.workspace).sort()) !== canonical(Object.keys(expected).sort())) throw new Error('Unexpected workspace inventory');
      for (const [name, contents] of Object.entries(expected)) {
        // O_NOFOLLOW closes the final-component symlink race; this is not an OS sandbox.
        const fd = openSync(join(this.workspace, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size !== Buffer.byteLength(contents) || readFileSync(fd, 'utf8') !== contents) throw new Error(`Changed fixture file: ${name}`);
        } finally { closeSync(fd); }
      }
    } catch (error) { throw new Error('Workspace integrity mismatch: expected only the recorded trusted fixture bytes', { cause: error }); }
  }
  private runTest(): TestResult {
    // No shell, inherited credentials, repository scripts, or user-provided executable bytes.
    const options = { cwd: this.workspace, timeout: 5000, maxBuffer: 64 * 1024,
      encoding: 'utf8' as const, env: { TZ: 'UTC', LANG: 'C', HOME: this.workspace },
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    const args = ['--permission', `--allow-fs-read=${this.workspace}`, '--disable-proto=throw', 'test.mjs'];
    const result = spawnSync(process.execPath, args, options);
    if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
      throw new Error('Fixture subprocess failed operationally', { cause: result.error });
    }
    const stdout = result.stdout;
    const stderr = result.stderr;
    // A missing assertion-runner marker is an operational failure, never a test outcome.
    if (!stdout.startsWith(result.status === 0 ? 'PASS authentication\n' : 'FAIL ')) {
      throw new Error('Fixture subprocess produced no valid test result');
    }
    return { passed: result.status === 0, exitCode: result.status, stdout, stderr };
  }

  close(): void { rmSync(this.workspace, { recursive: true, force: true }); }
}

export interface Intervention {
  parentTraceId: string; targetEventId: string; original: Json; replacement: DocsResponse; checkpointFingerprint: string;
}
export interface RunOptions { boundary?: Snapshot; intervention?: Intervention; store?: TraceStore }
export interface RunResult { events: ExecutionEvent[]; source: string; test: TestResult; finalSnapshot: Snapshot }

/** The same state machine is used for live recording, frozen replay and live continuation. */
export function executeAgent(driver: ToolDriver, options: RunOptions = {}): RunResult {
  const boundary = verifyBoundary(options.boundary ?? initialSnapshot());
  const recorder = new Recorder();
  const intervention = options.intervention;
  const started = recorder.emit('run.started', { agent: 'broken-auth-v1', config: boundary.config, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    ...(intervention ? { lineage: { parentTraceId: intervention.parentTraceId, targetEventId: intervention.targetEventId,
      checkpointFingerprint: intervention.checkpointFingerprint } } : {}) });
  let callCount = 0;
  function call(tool: Tool, input: Json, parentEventId = started.eventId): { output: Json; event: ExecutionEvent } {
    const callId = `call-${callCount++}`;
    const called = recorder.emit('tool.called', { callId, tool, input, metadata: { executor: 'fixture-v1' } }, parentEventId);
    if (tool === 'docs.lookup') {
      const checkpoint = recorder.emit('state.checkpoint', { snapshot: boundary }, called.eventId);
      if (intervention) {
        if (intervention.checkpointFingerprint !== boundary.fingerprint) throw new Error('Intervention checkpoint mismatch');
        recorder.emit('intervention.applied', intervention, checkpoint.eventId);
      }
    }
    let output: Json;
    try { output = driver.perform(tool, input); }
    catch (error) {
      recorder.emit('tool.completed', { callId, tool, output: null,
        error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }, called.eventId);
      throw error;
    }
    if (tool === 'docs.lookup' && intervention && canonical(output) !== canonical(intervention.replacement)) throw new Error('Driver did not apply the intervention');
    const event = recorder.emit('tool.completed', { callId, tool, output }, called.eventId);
    return { output, event };
  }
  let result: Omit<RunResult, 'events'>;
  try {
    const observation = call('docs.lookup', { topic: 'authentication' });
    const docs = docsResponseSchema.parse(observation.output);
    const source = generateSource(docs);
    const decision = recorder.emit('agent.decision', { api: docs.api, sourceHash: fingerprint(source) }, observation.event.eventId);
    const write = call('workspace.write', { path: 'solution.mjs', contents: source }, decision.eventId);
    if (canonical(write.output) !== canonical({ path: 'solution.mjs', contentHash: fingerprint(source) })) throw new Error('Write tool returned an inconsistent content hash');
    const testCall = call('tests.run', { suite: 'authentication' }, write.event.eventId);
    const test = testResultSchema.parse(testCall.output);
    recorder.emit('test.completed', test, testCall.event.eventId);
    const { fingerprint: _boundaryHash, ...body } = boundary;
    const finalSnapshot = snapshot({ ...body, agent: { ...boundary.agent, phase: 'completed' },
      files: { ...boundary.files, 'solution.mjs': source } });
    recorder.emit('state.checkpoint', { snapshot: finalSnapshot }, decision.eventId);
    recorder.emit('run.completed', { success: test.passed, finalFingerprint: finalSnapshot.fingerprint });
    result = { source, test, finalSnapshot };
  } catch (error) {
    recorder.emit('run.failed', { message: error instanceof Error ? error.message : String(error) });
    try { recorder.finish(options.store); }
    catch (storageError) { throw new AggregateError([error, storageError], 'Agent execution and failure persistence both failed'); }
    throw error;
  }
  return { ...result, events: recorder.finish(options.store) };
}
export function runLive(options: RunOptions = {}): RunResult & { workspace: string } {
  const driver = new LiveFixtureDriver(options.boundary ?? initialSnapshot(), options.intervention?.replacement ?? misleadingDocs);
  try { return { ...executeAgent(driver, options), workspace: driver.workspace }; }
  finally { driver.close(); }
}
