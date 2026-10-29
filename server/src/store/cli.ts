// The logs on this machine: export to JSONL, wipe, or report the reliance signals.
//   npm run logs:export           data/export-<time>/<table>.jsonl
//   npm run logs:wipe -- --yes    empties every table
//   npm run logs:report [-- --json]

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openLogs, TABLES} from './logs.js';
import {relianceSignals} from './report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = process.env.AGENT_DB || path.join(root, 'data', 'agent.db');
const [command, ...flags] = process.argv.slice(2);
const logs = openLogs(file);

if (command === 'export') {
  const dir = path.join(path.dirname(file), `export-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, {recursive: true});
  for (const table of TABLES) {
    const rows = logs.db.prepare(`SELECT * FROM ${table}`).all();
    fs.writeFileSync(path.join(dir, `${table}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    console.log(`${table}: ${rows.length}`);
  }
  console.log(`exported to ${dir}`);
} else if (command === 'wipe') {
  if (!flags.includes('--yes')) {
    console.error('This deletes every log row. Export first, then run: npm run logs:wipe -- --yes');
    process.exitCode = 1;
  } else {
    for (const table of TABLES) console.log(`${table}: ${logs.db.prepare(`DELETE FROM ${table}`).run().changes} deleted`);
    logs.db.exec('VACUUM');
  }
} else if (command === 'report') {
  const signals = relianceSignals(logs.db);
  if (flags.includes('--json')) console.log(JSON.stringify(signals, null, 2));
  else {
    for (const s of signals) {
      console.log(`\n${s.who}: ${s.sessions} session(s), ${s.messages} message(s)`);
      for (const [action, t] of Object.entries(s.tasks)) {
        console.log(`  ${action}: ${t.done} done, ${t.failed} failed, ${t.cancelled} stopped, ${t.revised} revised`);
      }
      const p = s.proposals;
      console.log(`  offered ${p.offered} (${p.fixes} fixes, ${p.plans} plans): ${p.stepsApplied} steps applied, ${p.stepsUndone} undone, ${p.withdrawn} withdrawn`);
      console.log(`  own work: ${s.ownWork.edits} edits, ${s.ownWork.runs} runs; agent steps per own edit: ${s.agentStepsPerOwnEdit ?? 'n/a'}`);
      for (const h of s.hints) console.log(`  question ${h.questionId}: opened ${h.opened}, ${h.shown} hint(s), highest level ${h.highestLevel ?? 'none'}`);
    }
    if (!signals.length) console.log('No events yet.');
  }
} else {
  console.error('Use: export | wipe --yes | report [--json]');
  process.exitCode = 1;
}
logs.close();
