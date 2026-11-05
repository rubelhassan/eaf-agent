/**
 * The event sender, own-work counts, the navigation lock's rules and the assistant keys.
 */
import {assert} from 'chai';
import {JSDOM} from 'jsdom';
import * as Blockly from 'blockly/core';
import {loadProgram} from '../eval/runner/programs.js';
import {AGENT_GROUP, createActivityCounter, createEventSender} from '../src/interaction/events.js';
import {shortcutAllowed} from '../src/util/navigation_lock.js';
import {bindAssistantKeys} from '../src/util/assistant_keys.js';
import {SHORTCUT_NAMES as N} from '../src/constants.js';

const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

suite('Event sender', function() {
  test('ids are unique, seq increases, a batch goes at 20 events or on flush', async function() {
    const batches = [];
    const sender = createEventSender({sink: (b) => batches.push(b), sessionId: 's1', batch: {ms: 1000, max: 20}});
    for (let i = 0; i < 25; i++) sender.record('task.stage', {taskId: 't1'});
    await settle();
    assert.lengthOf(batches, 1);
    assert.lengthOf(batches[0].events, 20);
    await sender.flush();
    assert.lengthOf(batches[1].events, 5);
    const all = batches.flatMap((b) => b.events);
    assert.equal(new Set(all.map((e) => e.id)).size, 25);
    assert.deepEqual(all.map((e) => e.seq), Array.from({length: 25}, (_, i) => i + 1));
    assert.deepEqual(batches[0].session, {id: 's1', learnerCode: null});
    sender.dispose();
  });

  test('a failing sink keeps its events for the next batch; past the buffer the oldest go', async function() {
    let fail = true;
    const batches = [];
    const sender = createEventSender({sink: async (b) => {
      if (fail) throw new Error('offline');
      batches.push(b);
    }, sessionId: 's1', batch: {ms: 1000, max: 1000}, buffer: 5});
    for (let i = 0; i < 3; i++) sender.record('a');
    await sender.flush();
    for (let i = 0; i < 4; i++) sender.record('b');
    fail = false;
    await sender.flush();
    assert.deepEqual(batches[0].events.map((e) => e.seq), [3, 4, 5, 6, 7]);
    sender.dispose();
  });

  test('the activity summary is an event, recorded only when it changed; client details go once', async function() {
    const counts = {edits: 0, runs: 0};
    const batches = [];
    const sender = createEventSender({sink: (b, how) => batches.push({...b, how}), sessionId: 's1', summary: () => ({...counts}),
      client: () => ({voice: 'kristin'})});
    sender.record('a');
    await sender.flush();
    sender.record('b');
    await sender.flush();
    counts.runs = 1;
    await sender.flush({final: true});
    assert.deepEqual(batches.map((b) => b.events.map((e) => e.kind)), [['a', 'activity.summary'], ['b'], ['activity.summary']]);
    assert.equal(batches[2].events[0].runs, 1);
    assert.deepEqual(batches.map((b) => b.session.client || null), [{voice: 'kristin'}, null, null]);
    assert.deepEqual(batches.map((b) => b.how.final), [false, false, true]);
    sender.dispose();
  });
});

suite('Own-work counts', function() {
  test('the learner\'s edits and runs count; the assistant\'s changes, undo and program loads don\'t', async function() {
    const ws = loadProgram(18);
    const activity = createActivityCounter(ws);
    ws.getBlockById('num_5').setFieldValue(7, 'NUM');
    Blockly.Events.setGroup(`${AGENT_GROUP}t1-g1`);
    ws.getBlockById('num_4').setFieldValue(9, 'NUM');
    Blockly.Events.setGroup(false);
    activity.ignoreUntilLoaded();
    Blockly.serialization.workspaces.load(Blockly.serialization.workspaces.save(loadProgram(18)), ws);
    await settle();
    ws.getBlockById('num_0').setFieldValue(3, 'NUM');
    activity.noteRun();
    await settle();
    assert.deepEqual(activity.counts(), {edits: 2, runs: 1});
    activity.dispose();
  });
});

suite('Navigation lock rules', function() {
  test('read-only lets moving and reading through and stops editing; frozen stops all but Escape', function() {
    for (const name of [N.NEXT, N.PREVIOUS, N.IN, N.OUT, N.CURSOR_LOC, N.RUN_PROGRAM, N.STACK_SEARCH, `${N.STACK_JUMP_PREFIX}B`, 'copy']) {
      assert.isTrue(shortcutAllowed('read-only', name), name);
    }
    for (const name of [N.INSERT, N.MARK, N.DISCONNECT, N.TOOLBOX, N.CUT, N.PASTE, N.DELETE, N.UNDO, N.EDIT_MODE,
      N.EDIT_STACK_LABEL, N.ADD_COMMENT, N.MOVE_STATEMENT_UP, N.MOVE_STATEMENT_DOWN, N.OPEN_DROPDOWN, 'delete', 'undo', 'redo']) {
      assert.isFalse(shortcutAllowed('read-only', name), name);
    }
    assert.isFalse(shortcutAllowed('frozen', N.NEXT));
    assert.isTrue(shortcutAllowed('frozen', 'escape'));
    assert.isTrue(shortcutAllowed('free', N.DELETE));
  });
});

suite('Assistant keys', function() {
  setup(function() {
    this.window = new JSDOM('<!doctype html><body><div id="x" tabindex="0"></div></body>').window;
    this.saved = global.document;
    global.document = this.window.document;
    this.ran = [];
    this.said = [];
    this.working = false;
    this.unbind = bindAssistantKeys({
      available: () => ['yes', 'stop'],
      run: (c) => this.ran.push(c),
      cancel: () => {
        if (!this.working) return false;
        this.working = false;
        this.ran.push('cancel');
        return true;
      },
      say: (t) => this.said.push(t),
      talk: () => this.ran.push('talk'),
    });
    this.press = (init) => {
      const e = new this.window.KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init});
      this.window.document.getElementById('x').dispatchEvent(e);
      return e;
    };
  });

  teardown(function() {
    this.unbind();
    global.document = this.saved;
  });

  test('Alt+Shift letters run commands by key code; an unavailable one says why', function() {
    const e = this.press({code: 'KeyY', key: '¥', altKey: true, shiftKey: true});
    assert.isTrue(e.defaultPrevented);
    this.press({code: 'KeyU', key: 'U', altKey: true, shiftKey: true});
    this.press({code: 'KeyY', key: 'y', altKey: true});
    assert.deepEqual(this.ran, ['yes']);
    assert.deepEqual(this.said, ['There is nothing to undo.']);
  });

  test('Ctrl+Shift+I stops the voice and talks; plain I is left to the editor', function() {
    assert.isFalse(this.press({code: 'KeyI', key: 'i'}).defaultPrevented);
    assert.isTrue(this.press({code: 'KeyI', key: 'I', ctrlKey: true, shiftKey: true}).defaultPrevented);
    assert.deepEqual(this.ran, ['talk']);
  });

  test('Escape stops a working task; otherwise it passes through', function() {
    assert.isFalse(this.press({key: 'Escape', code: 'Escape'}).defaultPrevented);
    this.working = true;
    assert.isTrue(this.press({key: 'Escape', code: 'Escape'}).defaultPrevented);
    assert.deepEqual(this.ran, ['cancel']);
  });
});
