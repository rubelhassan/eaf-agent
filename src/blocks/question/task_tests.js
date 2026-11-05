// @ts-check
/**
 * Task tests: teacher-only checks of a whole program. Each test gives
 * inputs (answers to prompt blocks, in order) and the lines that must appear in the
 * printed output, in that order. Exact tests allow no extra lines. Stored per task,
 * in the task XML root as:
 *
 *   <tests>
 *     <test><input>120</input><output>Too heavy! Wait for the next bridge.</output></test>
 *   </tests>
 *
 * This module never runs code: the host passes an `execute(inputs)` function.
 */

import * as Blockly from 'blockly/core';

/**
 * @typedef {Object} TaskTest
 * @property {!Array<string>} inputs  Answers fed to prompt blocks, in order.
 * @property {!Array<string>} expectedOutput  Lines that must be printed, in order.
 * @property {boolean=} exact  No extra or missing output lines; absent means in-order matching.
 */

/**
 * What the host reports after running the program once with a test's inputs.
 * @typedef {Object} Execution
 * @property {!Array<string>} lines  Printed lines.
 * @property {string=} error  Error message, if the program threw.
 * @property {boolean=} outOfInputs  The program asked for more inputs than given.
 * @property {boolean=} timedOut  The program ran too long and was stopped.
 */

/**
 * @typedef {Object} TestResult
 * @property {number} index  1-based.
 * @property {!TaskTest} test
 * @property {boolean} ok
 * @property {string} reason  Plain-language reason when it failed ('' when ok).
 * @property {!Array<string>} lines  What the program printed.
 */

/** @type {!WeakMap<!Object, !Array<!TaskTest>>} */
const testsByWorkspace = new WeakMap();

/** Policy-style lookup: flyouts and mutator workspaces resolve to the main workspace. */
function rootOf(workspace) {
  return workspace?.targetWorkspace || workspace;
}

const lineList = (value) => (Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : []);

/**
 * @param {*} raw
 * @returns {!Array<!TaskTest>} Valid tests only (a test needs at least one expected line).
 */
export function normalizeTests(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
      .map((t) => ({inputs: lineList(t?.inputs), expectedOutput: lineList(t?.expectedOutput),
        ...(t?.exact === true ? {exact: true} : {})}))
      .filter((t) => t.expectedOutput.length);
}

/** @returns {!Array<!TaskTest>} A copy of the task's tests. */
export function getTaskTests(workspace) {
  return (testsByWorkspace.get(rootOf(workspace)) || []).map((t) => ({
    inputs: [...t.inputs],
    expectedOutput: [...t.expectedOutput],
    ...(t.exact === true ? {exact: true} : {}),
  }));
}

/** Replaces the task's tests. */
export function setTaskTests(workspace, tests) {
  testsByWorkspace.set(rootOf(workspace), normalizeTests(tests));
}

/**
 * @param {!Array<!TaskTest>} tests
 * @returns {?Element} A <tests> element, or null when there are none.
 */
export function testsToDom(tests) {
  if (!tests.length) return null;
  const create = (tag, text) => {
    const element = Blockly.utils.xml.createElement(tag);
    if (text !== undefined) element.appendChild(Blockly.utils.xml.createTextNode(text));
    return element;
  };
  const root = create('tests');
  for (const test of tests) {
    const element = create('test');
    if (test.exact === true) element.setAttribute('exact', 'true');
    for (const line of test.inputs) element.appendChild(create('input', line));
    for (const line of test.expectedOutput) element.appendChild(create('output', line));
    root.appendChild(element);
  }
  return root;
}

/**
 * Reads and removes the <tests> element from a task XML root (Blockly's loader
 * doesn't know it).
 * @param {!Element} xmlRoot
 * @returns {!Array<!TaskTest>}
 */
export function takeTestsFromDom(xmlRoot) {
  const byTag = (parent, tag) => [...parent.childNodes].filter((n) => n.nodeName?.toLowerCase() === tag);
  const tests = [];
  for (const element of byTag(xmlRoot, 'tests')) {
    for (const test of byTag(element, 'test')) {
      tests.push({
        inputs: byTag(test, 'input').map((n) => n.textContent),
        expectedOutput: byTag(test, 'output').map((n) => n.textContent),
        exact: test.getAttribute('exact') === 'true',
      });
    }
    xmlRoot.removeChild(element);
  }
  return normalizeTests(tests);
}

/**
 * Whether the expected lines appear in the printed lines, in order (trimmed,
 * case-sensitive). Other printed lines may come before, between, or after.
 * @param {!Array<string>} expected
 * @param {!Array<string>} printed
 * @returns {{ok: boolean, missing?: string}} The first expected line not found, if any.
 */
export function matchInOrder(expected, printed) {
  let at = 0;
  const lines = printed.map((l) => String(l).trim());
  for (const line of expected) {
    const found = lines.indexOf(line.trim(), at);
    if (found < 0) return {ok: false, missing: line};
    at = found + 1;
  }
  return {ok: true};
}

/** Compare the whole output using the same trimming and case rules as in-order tests.
 * @param {!Array<string>} expected
 * @param {!Array<string>} printed
 * @returns {{ok: boolean, line?: number, expected?: string, printed?: string}} The first mismatch, if any.
 */
export function matchExactly(expected, printed) {
  const want = expected.map(line => String(line).trim());
  const got = printed.map(line => String(line).trim());
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i] !== got[i]) return {ok: false, line: i + 1, expected: want[i], printed: got[i]};
  }
  return {ok: true};
}

function exactOutputReason(expected, printed) {
  const match = matchExactly(expected, printed);
  if (match.ok) return '';
  if (match.expected === undefined) return `Unexpected output at line ${match.line}: "${match.printed}".`;
  if (match.printed === undefined) return `Expected "${match.expected}" at line ${match.line}, but it was not printed.`;
  return `Expected "${match.expected}" at line ${match.line}, but got "${match.printed}".`;
}

/**
 * Runs every test through the host's executor, one at a time.
 * @param {!Array<!TaskTest>} tests
 * @param {function(!Array<string>): (!Execution|!Promise<!Execution>)} execute
 * @returns {!Promise<!Array<!TestResult>>}
 */
export async function runTests(tests, execute) {
  const results = [];
  for (const [i, test] of tests.entries()) {
    /** @type {!Execution} */
    let run;
    try {
      run = await execute([...test.inputs]);
    } catch (e) {
      run = {lines: [], error: e instanceof Error ? e.message : String(e)};
    }
    const lines = run.lines || [];
    let reason = '';
    if (run.timedOut) reason = 'The program ran too long and was stopped.';
    else if (run.outOfInputs) reason = 'The program asked for more inputs than the test gives.';
    else if (run.error) reason = `The program stopped with an error: ${run.error}`;
    else if (test.exact === true) reason = exactOutputReason(test.expectedOutput, lines);
    else {
      const match = matchInOrder(test.expectedOutput, lines);
      if (!match.ok) reason = `Expected "${match.missing}", but it was not printed.`;
    }
    results.push({index: i + 1, test, ok: !reason, reason, lines});
  }
  return results;
}
