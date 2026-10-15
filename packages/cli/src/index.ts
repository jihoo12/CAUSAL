#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { exportJsonl, importJsonl } from '@causal/trace-schema';
import { SqliteTraceStore } from '@causal/recorder';
import { correctedDocs, runLive } from '@causal/broken-auth-agent';
import { exactReplay, forkTrace } from '@causal/replay-engine';
import { compare, experiment, humanComparison } from '@causal/experiment-engine';

const help = `CAUSAL — experimental counterfactual debugger (trusted deterministic fixture)

Usage: causal <command> [arguments] [--db <sqlite-path>] [--json]

  demo [--trials N] [--out directory]  Record, verify replay, intervene, test, save reports
  record                              Execute and save the original failing fixture
  traces                              List persisted traces
  inspect <trace-id>                   Show all validated events
  replay <trace-id>                    Re-execute decisions using frozen tool responses
  fork <trace-id> --event <event-id> --replacement <json-file>
  compare <original-id> <fork-id>      Compare outcomes, code, states, and lineage
  export <trace-id> --out <jsonl-file> Export a portable validated trace
  import <jsonl-file>                  Validate and store a trace (never executes it)

Default database: .causal/traces.sqlite
Expected fixture test failures are outcomes; operational errors exit nonzero.
`;
function main(): void {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, db: { type: 'string' },
    event: { type: 'string' }, replacement: { type: 'string' }, trials: { type: 'string' }, out: { type: 'string' },
  } });
  const [command, ...args] = positionals;
  if (values.help || !command || command === 'help') { console.log(help); return; }
  const arities: Record<string, number> = { demo: 0, record: 0, traces: 0, inspect: 1, replay: 1, fork: 1, compare: 2, export: 1, import: 1 };
  const arity = arities[command];
  if (arity === undefined) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (args.length !== arity) throw new Error(`${command} expects ${arity} positional argument(s). Use --help.`);
  const allowed: Record<string, string[]> = { demo: ['trials', 'out'], fork: ['event', 'replacement'], export: ['out'] };
  for (const key of Object.keys(values)) {
    if (!['help', 'json', 'db', ...(allowed[command] ?? [])].includes(key)) throw new Error(`--${key} is not valid for ${command}`);
  }
  function required(value: string | undefined, name: string): string {
    if (!value) throw new Error(`Missing required option --${name}`);
    return value;
  }
  function output(value: unknown, human?: string): void { console.log(values.json ? JSON.stringify(value, null, 2) : human ?? JSON.stringify(value, null, 2)); }
  const db = new SqliteTraceStore(resolve(values.db ?? '.causal/traces.sqlite'));
  try {
    switch (command) {
      case 'record': {
        const run = runLive({ store: db });
        output({ traceId: run.events[0]!.traceId, test: run.test }, `${run.events[0]!.traceId}: ${run.test.stdout.trim()}`); break;
      }
      case 'demo': {
        const trials = Number(values.trials ?? '1');
        if (!Number.isInteger(trials) || trials < 1 || trials > 100) throw new Error('Trials must be an integer between 1 and 100');
        const original = runLive({ store: db });
        const originalTraceId = original.events[0]!.traceId;
        const replay = exactReplay(db.load(originalTraceId));
        const target = original.events.find(e => e.eventType === 'tool.completed' && e.payload.tool === 'docs.lookup')!;
        const result = experiment({ original: db.load(originalTraceId), targetEventId: target.eventId,
          replacement: correctedDocs, trials, store: db });
        const directory = resolve(values.out ?? join('.causal', 'reports', originalTraceId));
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const forkTraceIds = result.trials.map(t => t.traceId);
        for (const id of [originalTraceId, ...forkTraceIds]) writeFileSync(join(directory, `${id}.jsonl`), exportJsonl(db.load(id)), { flag: 'wx', mode: 0o600 });
        const report = { originalTraceId, forkTraceIds, replay, reportDirectory: directory, experiment: result };
        const human = result.trials.map(t => humanComparison(t.comparison)).join('\n\n') +
          `\nExact recorded replay: equivalent (${replay.eventCount} events; frozen tools)\nSaved JSON, text, and JSONL traces: ${directory}\n`;
        writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        writeFileSync(join(directory, 'report.txt'), human, { flag: 'wx', mode: 0o600 });
        output(report, human); break;
      }
      case 'traces': {
        const rows = db.list();
        output(rows, rows.length ? rows.map(r => `${r.traceId}  ${r.outcome}  ${r.eventCount} events${r.parentTraceId ? `  parent=${r.parentTraceId}` : ''}`).join('\n') : 'No traces. Run causal demo.'); break;
      }
      case 'inspect': output(db.load(args[0]!)); break;
      case 'replay': {
        const replay = exactReplay(db.load(args[0]!));
        output(replay, `Equivalent: ${replay.eventCount} events, matching state fingerprints (frozen tool responses; no external tools re-executed).`); break;
      }
      case 'fork': {
        const eventId = required(values.event, 'event');
        const replacement: unknown = JSON.parse(readFileSync(required(values.replacement, 'replacement'), 'utf8'));
        const run = forkTrace(db.load(args[0]!), eventId, replacement, db);
        output({ traceId: run.events[0]!.traceId, parentTraceId: args[0], test: run.test }, `Fork ${run.events[0]!.traceId}: ${run.test.stdout.trim()}`); break;
      }
      case 'compare': {
        const report = compare(db.load(args[0]!), db.load(args[1]!));
        output(report, humanComparison(report)); break;
      }
      case 'export': {
        const path = required(values.out, 'out');
        writeFileSync(path, exportJsonl(db.load(args[0]!)), { flag: 'wx', mode: 0o600 });
        output({ path }, `Exported ${path}`); break;
      }
      case 'import': {
        const events = importJsonl(readFileSync(args[0]!, 'utf8'));
        db.save(events); output({ traceId: events[0]!.traceId }, `Imported ${events[0]!.traceId}`); break;
      }
    }
  } finally { db.close(); }
}
try { main(); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(process.argv.includes('--json') ? JSON.stringify({ error: message }) : `causal: ${message}`);
  process.exitCode = 1;
}
