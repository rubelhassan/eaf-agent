// The learner's Run on the program runner: the program runs in a worker with the learner limits, prompts use the
// browser's dialog (Cancel stops the run), Escape stops a running program, and the run says what happened.

const RUN_WORKER_URL = './keyboard-navigation/run_worker.js';

const RUN_SAY = {
    started: 'Running program',
    stillRunning: 'Your program is still running.',
    stopped: 'Program stopped.',
};

/** "the print block, block 3 of stack A", or '' when the block is gone. */
function runPlace(workspace, blockId) {
    const block = blockId && workspace.getBlockById(blockId);
    if (!block) return '';
    const where = describeBlockLocation(block).replace(/^stack (\w+), block (\d+)$/, 'block $2 of stack $1');
    return `the ${blockTypeName(block.type)} block${where ? `, ${where}` : ''}`;
}

/** The common engine errors in plain words. */
function plainError(error) {
    const message = error?.message || '';
    if (error?.name === 'RangeError' && /call stack/i.test(message)) return 'a function kept calling itself';
    if (error?.name === 'TypeError' && /undefined|null/.test(message)) return 'it used something that has no value yet';
    if (error?.name === 'TypeError' && /not a function/.test(message)) return "it used a value in a way that doesn't work";
    if (error?.name === 'ReferenceError') return "it used a name the program doesn't know";
    return 'it hit an error';
}

/** What the learner hears when a run ends; `panel` lines go to the output panel too. */
function runOutcome(workspace, result) {
    const where = runPlace(workspace, result.at || result.error?.blockId);
    const running = where ? ` It was running ${where}.` : '';
    switch (result.status) {
        case 'finished': {
            const n = result.lines.length;
            return { say: n ? `Program finished, ${n} ${n === 1 ? 'line' : 'lines'}. Shift O to read ${n === 1 ? 'it' : 'them'}.` :
                'Program finished, no lines.', panel: [] };
        }
        case 'stepLimit':
        case 'timeLimit': {
            const say = `Your program ran too long, so I stopped it.${running}`;
            return { say, panel: [say] };
        }
        case 'lineLimit': {
            const say = `Your program printed more than ${LEARNER_LIMITS.lines.toLocaleString('en-US')} lines, so I stopped it.${running}`;
            return { say, panel: [say] };
        }
        case 'error': {
            const say = `Your program stopped${where ? ` at ${where}` : ''}: ${plainError(result.error)}.`;
            return { say, panel: [say, `Error: ${result.error?.message || 'unknown'}`] };
        }
        default:
            return { say: RUN_SAY.stopped, panel: [RUN_SAY.stopped] };
    }
}

// How long to wait for the built-in voice to start a question, and at most for it to finish.
const QUESTION_START_MS = 500;
const QUESTION_MAX_MS = 15000;

/**
 * A screen reader reads the browser's dialog itself; with navigation on the built-in voice, the question is said first.
 * The dialog blocks the page, so it opens once the line is spoken.
 */
function sayBeforeDialog(say, text) {
    const output = window.eafOutput;
    if (!text || output?.settings().systemOutput !== 'systemVoice') return Promise.resolve();
    return new Promise((resolve) => {
        let started = false;
        let off = () => {};
        const timers = [];
        const done = () => {
            off();
            timers.forEach(clearTimeout);
            resolve();
        };
        off = output.onState((state) => {
            if (state === 'announcing') started = true;
            else if (started) done();
        });
        // Speech that never starts (keyboard navigation off) doesn't hold the dialog back.
        timers.push(setTimeout(() => started || done(), QUESTION_START_MS), setTimeout(done, QUESTION_MAX_MS));
        say(text);
    });
}

/**
 * @param {{workspace: !Blockly.WorkspaceSvg, say: function(string): void, appendOutput: function(string): void,
 *     escapeFirst?: function(!KeyboardEvent): boolean}} host
 *     escapeFirst: who gets Escape before the run (the magnifier's lens); true when it took the press
 * @returns {{run: function(): !Promise<?Object>, isRunning: function(): boolean}}
 */
function createLearnerRun({ workspace, say, appendOutput, escapeFirst = () => false }) {
    const runner = createWorkerRunner(() => new Worker(RUN_WORKER_URL));
    let running = null;
    // On window in the capture phase, ahead of the assistant's Escape (one press stops one thing).
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !running || escapeFirst(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        running.abort();
    }, true);

    return {
        isRunning: () => !!running,
        /** Runs the program once; null when a run is already going. */
        async run() {
            if (running) {
                say(RUN_SAY.stillRunning);
                return null;
            }
            running = new AbortController();
            const { signal } = running;
            try {
                const { code, blockIds } = compileProgram(workspace, javascript.javascriptGenerator, { input: 'ask' });
                say(RUN_SAY.started);
                const result = await runner.run({ code, blockIds, input: 'ask', limits: LEARNER_LIMITS }, {
                    signal,
                    onLine: (line) => appendOutput(line.text),
                    // Cancel in the dialog (null) stops the run.
                    onInput: async (prompt) => {
                        await sayBeforeDialog(say, prompt);
                        // Stopped while the question was spoken: no dialog.
                        return signal.aborted ? null : window.prompt(prompt);
                    },
                });
                const outcome = runOutcome(workspace, result);
                outcome.panel.forEach(appendOutput);
                say(outcome.say);
                return result;
            } catch (error) {
                appendOutput(`Error: ${error.message}`);
                say('Your program could not run.');
                return null;
            } finally {
                running = null;
            }
        },
    };
}

let headlessRunner = null;

/** One run for the assessment: answers from the list, the headless limits, in a worker. */
async function runHeadless(workspace, inputs) {
    headlessRunner ||= createWorkerRunner(() => new Worker(RUN_WORKER_URL));
    const { code, blockIds } = compileProgram(workspace, javascript.javascriptGenerator);
    return toExecution(await headlessRunner.run({ code, blockIds, input: 'list', inputs, limits: HEADLESS_LIMITS }));
}
