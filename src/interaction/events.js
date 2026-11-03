// @ts-check
// Task and session events for the logs: ids, sequence numbers, batches to a sink, and a buffer that keeps
// events when the sink fails. Plus counts of the learner's own edits and runs.

import * as Blockly from 'blockly/core';
import {AGENT_GROUP, creatorOf, Creator} from '../blocks/authorship.js';

export {AGENT_GROUP};

/**
 * @param {{sink: function(!Object, {final: boolean}): (void|!Promise<void>), sessionId: string, learnerCode?: ?string,
 *     assistantName?: ?string, batch?: {ms: number, max: number}, buffer?: number, now?: function(): number,
 *     summary?: function(): ?Object, client?: function(): ?Object}} options
 *     sink: takes {session, events} (final: the page is closing); throwing or rejecting keeps the events for the next batch.
 *     summary: activity counts, recorded as an activity.summary event when they changed.
 *     client: app details for the session (settings), sent when they changed.
 *     assistantName: the assistant's name, which the server never masks in event text (without it: Neon).
 */
export function createEventSender({sink, sessionId, learnerCode = null, assistantName = null, batch = {ms: 5000, max: 20}, buffer = 500,
  now = () => Date.now(), summary = () => null, client = () => null}) {
  let seq = 0;
  let queue = [];
  let timer = null;
  let sending = false;
  let lastSummary = null;
  let sentClient = null;

  function schedule() {
    if (timer || !queue.length) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, batch.ms);
  }

  function record(kind, data = {}) {
    seq += 1;
    // Data never overrides the event's own fields.
    queue.push({...data, id: `e_${sessionId}_${seq}`, seq, time: new Date(now()).toISOString(), kind});
    if (queue.length > buffer) queue.splice(0, queue.length - buffer);
  }

  async function flush({final = false} = {}) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const counts = summary();
    if (counts && JSON.stringify(counts) !== JSON.stringify(lastSummary)) {
      lastSummary = counts;
      record('activity.summary', counts);
    }
    if (sending || !queue.length) return;
    sending = true;
    const events = queue;
    queue = [];
    const details = client();
    const newClient = details && JSON.stringify(details) !== JSON.stringify(sentClient) ? details : null;
    try {
      const session = {id: sessionId, learnerCode, ...(assistantName ? {assistantName} : {}), ...(newClient ? {client: newClient} : {})};
      await sink({session, events}, {final});
      if (newClient) sentClient = newClient;
    } catch (e) {
      // Kept for the next batch; past the buffer size the oldest go.
      queue = [...events, ...queue].slice(-buffer);
    } finally {
      sending = false;
    }
    schedule();
  }

  return {
    /** @param {string} kind  e.g. task.started, step.applied */
    record(kind, data = {}) {
      record(kind, data);
      if (queue.length >= batch.max) flush();
      else schedule();
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Counts the learner's own edits (one per Blockly change group, leaving out the coordinator's changes, undo and
 * program loads) and runs, and assistantBlockEdits, the learner's changes to blocks the assistant made.
 * @param {!Blockly.Workspace} workspace
 */
export function createActivityCounter(workspace) {
  const counts = {edits: 0, runs: 0, assistantBlockEdits: 0};
  const seen = new Set();
  const assistantEdits = new Set();
  let loading = false;
  const listener = (e) => {
    if (e.type === Blockly.Events.FINISHED_LOADING) {
      loading = false;
      return;
    }
    if (loading || e.isUiEvent || !e.recordUndo || String(e.group || '').startsWith(AGENT_GROUP)) return;
    const key = e.group || `${e.type}-${e.blockId}-${counts.edits}`;
    if (e.type === Blockly.Events.BLOCK_CHANGE && creatorOf(workspace.getBlockById(e.blockId)) === Creator.ASSISTANT &&
        !assistantEdits.has(key)) {
      assistantEdits.add(key);
      counts.assistantBlockEdits += 1;
    }
    if (seen.has(key)) return;
    seen.add(key);
    counts.edits += 1;
  };
  workspace.addChangeListener(listener);
  return {
    counts: () => ({...counts}),
    noteRun() {
      counts.runs += 1;
    },
    /** Before loading a program: its events are not the learner's edits. */
    ignoreUntilLoaded() {
      loading = true;
    },
    dispose: () => workspace.removeChangeListener(listener),
  };
}
