// Reliance signals per learner (or per session without a learner code), from the stored events. The teacher view
// will read the same queries.

import type Database from 'better-sqlite3';

export interface Signals {
  who: string;
  sessions: number;
  messages: number;
  tasks: Record<string, {done: number; failed: number; cancelled: number; revised: number}>;
  proposals: {offered: number; fixes: number; plans: number; stepsApplied: number; stepsUndone: number; withdrawn: number};
  hints: Array<{questionId: string; opened: number; shown: number; highestLevel: string | null}>;
  ownWork: {edits: number; runs: number};
  /** agent steps applied for each of the learner's own edits */
  agentStepsPerOwnEdit: number | null;
}

const who = `coalesce(s.learner_code, 'session ' || e.session_id)`;

export function relianceSignals(db: Database.Database): Signals[] {
  const rows = db.prepare(`SELECT ${who} AS who, e.session_id, e.kind, e.task_id, e.data FROM events e
    LEFT JOIN sessions s ON s.session_id = e.session_id ORDER BY e.session_id, e.seq`).all() as
    Array<{who: string; session_id: string; kind: string; task_id: string | null; data: string}>;
  const out = new Map<string, Signals & {sessionSet: Set<string>; actions: Map<string, string>; lastSummary: Map<string, {edits: number; runs: number}>;
    hintMap: Map<string, {opened: number; shown: number; highestLevel: string | null}>}>();
  for (const r of rows) {
    if (!out.has(r.who)) {
      out.set(r.who, {who: r.who, sessions: 0, messages: 0, tasks: {}, proposals: {offered: 0, fixes: 0, plans: 0, stepsApplied: 0,
        stepsUndone: 0, withdrawn: 0}, hints: [], ownWork: {edits: 0, runs: 0}, agentStepsPerOwnEdit: null,
      sessionSet: new Set(), actions: new Map(), lastSummary: new Map(), hintMap: new Map()});
    }
    const s = out.get(r.who)!;
    s.sessionSet.add(r.session_id);
    const data = JSON.parse(r.data) as Record<string, any>;
    const task = (action: string) => (s.tasks[action] ||= {done: 0, failed: 0, cancelled: 0, revised: 0});
    if (data.action && r.task_id) s.actions.set(r.task_id, data.action);
    const action = (r.task_id && s.actions.get(r.task_id)) || 'unknown';
    switch (r.kind) {
      case 'message.submitted': s.messages++; break;
      case 'task.done': task(action).done++; break;
      case 'task.failed': task(action).failed++; break;
      case 'task.cancelled': task(action).cancelled++; break;
      case 'task.revised': task(action).revised++; break;
      case 'proposal.offered':
        s.proposals.offered++;
        if (data.proposalKind === 'fix') s.proposals.fixes++;
        else s.proposals.plans++;
        break;
      case 'proposal.withdrawn': s.proposals.withdrawn++; break;
      case 'step.applied': s.proposals.stepsApplied += Number(data.count) || 1; break;
      case 'step.undone': s.proposals.stepsUndone += Number(data.count) || 1; break;
      case 'activity.summary':
        // Counts are totals since the page loaded, so the last one per session counts.
        s.lastSummary.set(r.session_id, {edits: Number(data.edits) || 0, runs: Number(data.runs) || 0});
        break;
      case 'hint.opened':
      case 'hint.shown': {
        const h = s.hintMap.get(data.questionId) || {opened: 0, shown: 0, highestLevel: null};
        if (r.kind === 'hint.opened') h.opened++;
        else {
          h.shown++;
          h.highestLevel = data.level ?? h.highestLevel;
        }
        s.hintMap.set(data.questionId, h);
        break;
      }
    }
  }
  return [...out.values()].map(({sessionSet, actions, lastSummary, hintMap, ...s}) => {
    for (const c of lastSummary.values()) {
      s.ownWork.edits += c.edits;
      s.ownWork.runs += c.runs;
    }
    return {...s, sessions: sessionSet.size, hints: [...hintMap].map(([questionId, h]) => ({questionId, ...h})),
      agentStepsPerOwnEdit: s.ownWork.edits ? Math.round((s.proposals.stepsApplied / s.ownWork.edits) * 100) / 100 : null};
  });
}
