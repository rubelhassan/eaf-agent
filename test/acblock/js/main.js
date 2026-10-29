// list block program xml
const PROGRAMS = [
    // Hand-written example of configured question blocks (prompts, hints, intended blocks).
    { id: 'DemoQuestions', label: 'Demo 1: Question Blocks', file: 'xml/tasks/question-demo.xml' },
    // Program 18 turned into tasks: the same questions as practice, as a quiz, and as one sequence question.
    { id: 'DemoSkipCountPractice', label: 'Demo 2: Skip Count (Practice)', file: 'xml/tasks/skip-count-practice.xml' },
    { id: 'DemoSkipCountQuiz', label: 'Demo 3: Skip Count (Quiz)', file: 'xml/tasks/skip-count-quiz.xml' },
    { id: 'DemoSkipCountSequence', label: 'Demo 4: Skip Count (Sequence)', file: 'xml/tasks/skip-count-sequence.xml' },
    // A plain program for trying Make scaffold as a teacher.
    { id: 'DemoMakeScaffold', label: 'Demo 5: Make a Scaffold (Teacher)', file: 'xml/programs/18.xml' },
    ...Array.from({ length: 54 }, (_, i) => ({
        id: `Program${i + 1}`,
        label: `Program ${i + 1}`,
        file: `xml/programs/${i + 1}.xml`,
    })),
];

const LEARNER_LEVEL_KEY = 'eaf.learnerLevel';

/** Toolbox without question blocks, for learners (teachers see them). */
function toolboxFor(teacherMode) {
    if (teacherMode) return toolboxConfig;
    const strip = (node) => {
        if (Array.isArray(node)) {
            return node.filter(n => n.type !== QuestionBlock.QUESTION_TYPE).map(strip)
                // A category left empty (the Hint category) disappears.
                .filter(n => !(String(n.kind).toUpperCase() === 'CATEGORY' && Array.isArray(n.contents) && !n.contents.length));
        }
        if (node && typeof node === 'object' && node.contents) return { ...node, contents: strip(node.contents) };
        return node;
    };
    return strip(toolboxConfig);
}

/** Teacher mode (only offered with ?teacher=1): toolbox, task snapshot, activity, export/import. */
/** The Navigation On/Off toggle, kept in step with Ctrl+Shift+K. */
function setupNavToggle(workspace) {
    const button = document.getElementById('navToggle');
    const state = document.getElementById('navToggleState');
    const sync = () => {
        const on = !!workspace.keyboardAccessibilityMode;
        button.setAttribute('aria-pressed', String(on));
        state.textContent = on ? 'On' : 'Off';
    };
    button.addEventListener('click', () => {
        const toggle = Blockly.ShortcutRegistry.registry.getRegistry()[Constants.SHORTCUT_NAMES.TOGGLE_KEYBOARD_NAV];
        toggle?.callback(workspace);
        sync();
        // Blockly listens for keys on its own svg, so move focus there to use the keys right away.
        if (workspace.keyboardAccessibilityMode) workspace.getParentSvg()?.focus();
    });
    document.addEventListener('keyup', sync, true);
    sync();
}

/** Closes Settings and parks focus on the gear, so a dialog's Escape and focus return work. */
function openFromSettings(open) {
    window.eafSettings?.close();
    document.getElementById('settingsButton').focus();
    open();
}

/**
 * What the assistant reads from the app and may do in it: the cursor, the stack letters learners hear,
 * moving to a block the learner asked for, and opening a question's help.
 */
function assistantView(workspace) {
    return {
        cursor() {
            const node = workspace.getCursor()?.getCurNode();
            if (!node) return { block: null };
            if (node.getType() === Blockly.ASTNode.types.WORKSPACE) {
                const at = node.getWsCoordinate();
                return { block: null, at: at ? { x: at.x, y: at.y } : null };
            }
            if (node.getType() === Blockly.ASTNode.types.FIELD) {
                const field = node.getLocation();
                return { block: field.getSourceBlock()?.id || null, field: field.name || null };
            }
            return { block: node.getSourceBlock()?.id || null };
        },
        stackLetters: () => getStackLabelManager(workspace)?.stackLetters() || null,
        // To a block, or back to a cursor taken earlier (a block, or a spot on empty workspace).
        moveCursor(target, { focus = true } = {}) {
            const where = typeof target === 'string' ? { block: target } : target;
            const block = where.block && workspace.getBlockById(where.block);
            let node = null;
            if (block) node = Blockly.ASTNode.createBlockNode(block);
            else if (where.at) node = Blockly.ASTNode.createWorkspaceNode(workspace, new Blockly.utils.Coordinate(where.at.x, where.at.y));
            if (!node) return;
            workspace.getCursor()?.setCurNode(node);
            if (block) workspace.centerOnBlock(block.id);
            if (focus) workspace.getParentSvg()?.focus();
        },
        openQuestion(id) {
            const block = workspace.getBlockById(id);
            if (block) blockTypes.activate(block, { workspace, speech: navController.speech });
        },
    };
}

function agentReady() {
    if (!window.eafAgent) throw new AgentError(AgentErrorCode.UNAVAILABLE, 'The agent is not ready yet.');
    return window.eafAgent;
}

/** Downloads XML named after the chosen program, e.g. "DemoQuestions-work.xml". */
function downloadXml(xml, suffix) {
    const name = document.getElementById('programSelect').value;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    link.download = name && name !== 'Default' ? `${name}-${suffix}.xml` : `${suffix}.xml`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function setupTeacherMode(workspace, runOnRun) {
    const params = new URLSearchParams(window.location.search);
    // ?author=1 is the old name of the teacher URL.
    if (params.get('teacher') !== '1' && params.get('author') !== '1') return;
    const modeRow = document.getElementById('teacherModeRow');
    const toolsRow = document.getElementById('teacherToolsRow');
    const toggle = document.getElementById('teacherModeToggle');
    const state = document.getElementById('teacherModeState');
    const activity = document.getElementById('activitySelect');
    const wholePlan = document.getElementById('wholePlanToggle');
    const voiceFallback = document.getElementById('voiceFallbackToggle');
    modeRow.hidden = false;

    const render = () => {
        const on = getPolicy(workspace).teacherMode;
        toggle.setAttribute('aria-checked', String(on));
        state.textContent = on ? 'On' : 'Off';
        toolsRow.hidden = !on;
        activity.value = getPolicy(workspace).activity;
        wholePlan.setAttribute('aria-checked', String(getPolicy(workspace).wholePlan));
        document.getElementById('wholePlanState').textContent = getPolicy(workspace).wholePlan ? 'On' : 'Off';
        voiceFallback.setAttribute('aria-checked', String(getPolicy(workspace).voiceFallback));
        document.getElementById('voiceFallbackState').textContent = getPolicy(workspace).voiceFallback ? 'On' : 'Off';
        // Questions are ordinary blocks in teacher mode (nothing vanishes), so make the role obvious.
        const badge = document.getElementById('roleBadge');
        badge.hidden = false;
        const icon = document.createElement('i');
        icon.className = `fas ${on ? 'fa-chalkboard-user' : 'fa-user-graduate'}`;
        icon.setAttribute('aria-hidden', 'true');
        badge.replaceChildren(icon, on ? ' Teacher' : ' Learner');
        badge.className = `role-badge role-badge-${on ? 'teacher' : 'learner'}`;
        document.getElementById('blocklyApp').setAttribute('aria-label', on ? 'Blockly workspace, teacher mode' : 'Blockly workspace');
    };
    toggle.addEventListener('click', () => setPolicy(workspace, { teacherMode: !getPolicy(workspace).teacherMode }));
    activity.addEventListener('change', () => setPolicy(workspace, { activity: activity.value }));
    wholePlan.addEventListener('click', () => setPolicy(workspace, { wholePlan: !getPolicy(workspace).wholePlan }));
    voiceFallback.addEventListener('click', () => setPolicy(workspace, { voiceFallback: !getPolicy(workspace).voiceFallback }));
    onPolicyChange(workspace, (next, previous) => {
        if (next.teacherMode !== previous.teacherMode) workspace.updateToolbox(toolboxFor(next.teacherMode));
        render();
    });

    document.getElementById('exportTaskBtn').addEventListener('click', () => {
        downloadXml(QuestionBlock.cleanTaskXml(workspace), 'task');
    });
    // Teacher-only: tests of the whole program, used when assessing a learner's work.
    const testsDialog = new QuestionBlock.TaskTestsDialog(workspace, { onRun: runOnRun });
    document.getElementById('taskTestsBtn').addEventListener('click', () => openFromSettings(() => testsDialog.open()));
    document.getElementById('makeScaffoldBtn').addEventListener('click', () =>
        openFromSettings(() => QuestionBlock.openScaffoldDialog(workspace)));
    const file = document.getElementById('importTaskFile');
    document.getElementById('importTaskBtn').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
        const chosen = file.files[0];
        file.value = '';
        if (!chosen || !confirm('Replace the current workspace with this task?')) return;
        loadXmlToWorkspace(workspace, await chosen.text());
    });
    // Opening the teacher URL starts in teacher mode.
    setPolicy(workspace, { teacherMode: true });
    render();
}

/** Learner level preference (Settings): applied to the workspace policy, remembered per browser. */
function setupLearnerLevel(workspace) {
    const select = document.getElementById('learnerLevelSelect');
    if (!select) return;
    let saved = null;
    try {
        saved = localStorage.getItem(LEARNER_LEVEL_KEY);
    } catch (e) { /* storage unavailable: use the default */ }
    if (saved && [...select.options].some(o => o.value === saved)) select.value = saved;
    setPolicy(workspace, { learnerLevel: select.value });
    select.addEventListener('change', () => {
        setPolicy(workspace, { learnerLevel: select.value });
        try {
            localStorage.setItem(LEARNER_LEVEL_KEY, select.value);
        } catch (e) { /* not remembered, still applied */ }
    });
}

function populateProgramsToDom() {
    const select = document.getElementById('programSelect');
    select.innerHTML = '<option value="Default">Select a program…</option>';
    PROGRAMS.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        select.appendChild(opt);
    });
}

function allowedTypeCatalog(toolboxConfig) {
    const types = new Set();

    const add = (t) => t && typeof t === 'string' && types.add(t);

    const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node !== 'object') return;

        // any block/shadow definition
        if (node.type) add(node.type);

        // inputs may contain nested blocks/shadows
        if (node.inputs) {
            for (const k in node.inputs) {
                const inp = node.inputs[k];
                if (inp?.shadow) walk(inp.shadow);
                if (inp?.block) walk(inp.block);
            }
        }

        // recurse into category contents
        if (node.contents) walk(node.contents);

        // dynamic categories (minimal defaults)
        if (node.custom) {
            const c = String(node.custom).toUpperCase();
            if (c === 'VARIABLE' || c === 'VARIABLE_DYNAMIC') {
                ['variables_get', 'variables_set', 'math_change'].forEach(add);
            } else if (c === 'PROCEDURE') {
                [
                    'procedures_defnoreturn',
                    'procedures_defreturn',
                    'procedures_callnoreturn',
                    'procedures_callreturn',
                    'procedures_ifreturn',
                ].forEach(add);
            }
        }
    };

    walk(toolboxConfig?.contents ?? toolboxConfig);
    return [...types].sort();
}


function getProgramIdFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('programId');
    return v ? v.trim() : null;
}

function findProgramById(id) {
    const target = String(id).toLowerCase();
    return PROGRAMS.find(p => p.id.toLowerCase() === target);
}

async function fetchProgramXmlById(id) {
    const entry = PROGRAMS.find(p => p.id === id);
    if (!entry) throw new Error('Program not found');
    const res = await fetch(entry.file, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    return await res.text();
}


/** Set in init; program loads reset keyboard navigation through it. */
let navController = null;

function loadXmlToWorkspace(workspace, xmlString) {
    try {
        // Loads with gap rules suspended, applies the file's activity (practice/quiz),
        // and records its blocks as the task (for quiz locks).
        // A loaded program is not the learner's own work.
        window.eafActivity?.ignoreUntilLoaded();
        QuestionBlock.loadTaskXml(workspace, xmlString);
        navController?.resetNavigation(workspace);
        document.getElementById('activitySelect').value = getPolicy(workspace).activity;
        requestAnimationFrame(() => {
            if (typeof workspace.scrollCenter === 'function') workspace.scrollCenter();
            if (typeof Blockly.svgResize === 'function') Blockly.svgResize(workspace);
        });
    } catch (e) {
        alert("Invalid XML format.");
        console.error(e);
    }
}

async function loadSelectedProgramIntoWorkspace(workspace) {
    const select = document.getElementById('programSelect');
    const id = select.value;
    if (!id) {
        alert('Pick a program first.');
        return;
    }
    try {
        const xml = await fetchProgramXmlById(id);
        loadXmlToWorkspace(workspace, xml);
    } catch (e) {
        console.error(e);
        alert('Could not load XML file.');
    }
}

async function autoLoadProgramFromQuery(workspace) {
    const programId = getProgramIdFromQuery();
    if (!programId) {
        return;
    }

    const match = findProgramById(programId);
    if (!match) {
        console.warn(`No program found for id "${programId}".`);
        return;
    }

    const select = document.getElementById('programSelect');
    select.value = match.id;

    // Trigger the change event to load the program
    const changeEvent = new Event('change', { bubbles: true });
    select.dispatchEvent(changeEvent);
}

function initWorkspace() {
    // load program as html select items
    populateProgramsToDom();

    // Override the text_print block to use console.log instead of alert
    javascript.javascriptGenerator.forBlock['text_print'] = function(block, generator) {
        const msg = generator.valueToCode(block, 'TEXT', javascript.Order.NONE) || "''";
        return 'console.log(' + msg + ');\n';
    };

    // Custom blocks (e.g. the question block) must be registered before the workspace exists.
    const {connectionChecker} = registerCustomBlocks({
        generators: {
            javascript: javascript.javascriptGenerator,
            python: python.pythonGenerator,
            php: php.phpGenerator,
            lua: lua.luaGenerator,
            dart: dart.dartGenerator,
        },
    });

    // Blockly Workspace Initialization
    const workspace = Blockly.inject('blocklyDiv', {
        toolbox: toolboxFor(false),
        plugins: {connectionChecker},
        grid: {spacing: 20, length: 3, colour: "#ccc", snap: true},
        zoom: {
            controls: true,
            wheel: true,
            startScale: 1.0,
            maxScale: 3,
            minScale: 0.3,
            scaleSpeed: 1.2,
            pinch: true
        },
        trashcan: true
    });


    // The agent may never create question gaps (design doc G2), so keep them out of its catalog.
    workspace.allowedTypeCatalog = allowedTypeCatalog(toolboxConfig)
        .filter(type => type !== QuestionBlock.QUESTION_TYPE);
    window.workspace = workspace;

    let nav = new NavigationController();
    nav.init();
    nav.addWorkspace(workspace);
    navController = nav;
    // Speech and sound cues go through the output manager from here on.
    window.eafOutput = setupOutput(workspace);
    // Keyboard navigation is on from the start: every key the walkthroughs teach needs it.
    nav.enable(workspace);
    setupNavToggle(workspace);
    // Blockly reads keys on its own svg. Tabbing into the app lands on its container
    // first, so hand focus to the svg when it arrives from outside the app.
    const app = document.getElementById('blocklyApp');
    app.addEventListener('focusin', (e) => {
        const fromOutside = !e.relatedTarget || !app.contains(e.relatedTarget);
        const svg = workspace.getParentSvg();
        if (fromOutside && e.target !== svg && (e.target === app || e.target.classList.contains('injectionDiv'))) svg.focus();
    });

    // Question gap tracking and answer badges; announcements go through the screen reader speech.
    attachCustomBlocks(workspace, {
        announce: (text) => nav.speech.update(text),
        // Hint events go to the event sender, which index.html sets up later.
        onEvent: (kind, data) => window.eafEvents?.record(kind, data),
        // index.html sets window.eafAgent once the agent config has loaded.
        agent: {
            generateHint: (request, options) => agentReady().generateHint(request, options),
            generateScaffold: (request, options) => agentReady().generateScaffold(request, options),
        },
    });
    setupLearnerLevel(workspace);
    const run = () => runProgram(workspace, nav.speech);
    setupTeacherMode(workspace, run);
    // Learners hand in their work as a file; a teacher imports it and Run assesses it.
    document.getElementById('saveWorkBtn').addEventListener('click', () => {
        downloadXml(QuestionBlock.workXml(workspace), 'work');
    });

    const keyOverlay = new KeyOverlay({ hideDelayMs: 5000 });
    keyOverlay.attach();

    document.getElementById("runButton").addEventListener("click", run);

    document.getElementById("languageSelect").addEventListener("change", () => generateCode(workspace));

    // Auto-load program when selection changes
    document.getElementById("programSelect").addEventListener("change", async () => {
        const select = document.getElementById("programSelect");
        const selectedId = select.value;

        if (!selectedId || selectedId === "Default") {
            // Clear workspace if no program selected
            workspace.clear();
            return;
        }

        try {
            const xml = await fetchProgramXmlById(selectedId);
            loadXmlToWorkspace(workspace, xml);
        } catch (e) {
            console.error(e);
            alert('Could not load the selected program.');
        }
    });

    document.getElementById("showShortcuts")?.addEventListener("click", () => {
        nav?.showShortcuts();
    });

    // auto select & load program if query param is provided
    autoLoadProgramFromQuery(workspace);
    // renderKeyboardHints(null);
}

function generateCode(workspace = Blockly.getMainWorkspace()) {
    const language = document.getElementById("languageSelect").value;
    let code;
    switch (language) {
        case "javascript":
            code = javascript.javascriptGenerator.workspaceToCode(workspace);
            break;
        case "python":
            code = python.pythonGenerator.workspaceToCode(workspace);
            break;
        case "php":
            code = php.phpGenerator.workspaceToCode(workspace);
            break;
        case "lua":
            code = lua.luaGenerator.workspaceToCode(workspace);
            break;
        case "dart":
            code = dart.dartGenerator.workspaceToCode(workspace);
            break;
        case "xml":
            const xmlDom = Blockly.Xml.workspaceToDom(workspace);
            code = Blockly.Xml.domToPrettyText(xmlDom);
            break;
        default:
            code = "// Select a language";
    }
    let codePanel = document.getElementById("codeOutput");
    codePanel.textContent = code;
    codePanel.classList.remove('prettyprinted');
    if (typeof PR === 'object') {
        PR.prettyPrint();
    }
}

/**
 * Run: learners get a compact warning about unanswered questions (tests never run
 * for them); teachers get an assessment of the program (questions, then task tests)
 * after the normal run. Spoken too while keyboard navigation is on.
 */
function runProgram(workspace, speech) {
    window.eafActivity?.noteRun();
    // Close Blockly Pilot panel if open
    if (window.blocklyPilot && window.blocklyPilot.state.panelVisible) {
        window.blocklyPilot.close();
    }
    clearOutput();
    const say = (text) => {
        if (workspace.keyboardAccessibilityMode) speech.update(text);
    };
    const { teacherMode } = getPolicy(workspace);
    if (!teacherMode) {
        const warning = QuestionBlock.learnerRunWarning(workspace);
        if (warning) {
            appendOutput(`Note: ${warning}`);
            say(warning);
        }
    }

    // Setup output capture only when running code
    const restoreConsole = setupOutputCapture();
    generateCode(workspace);
    try {
        eval(document.getElementById("codeOutput").textContent);
    } catch (error) {
        appendOutput("Error: " + error.message);
    } finally {
        // Restore original console.log after execution
        restoreConsole();
    }

    if (teacherMode) {
        const report = QuestionBlock.assess(workspace, {
            execute: (inputs) => runSilently(workspace, inputs),
            locate: describeBlockLocation,
        });
        appendOutput('Assessment');
        report.lines.forEach((line) => appendOutput(line));
        say(report.summary || 'Assessment done.');
    }
}

const SILENT_RUN_MAX_LOOPS = 100000;
const SILENT_RUN_MAX_MS = 1000;

/**
 * Runs the program once without touching the page: prompt answers come from
 * `inputs` in order, printed lines are captured, and loops are capped.
 * @returns {{lines: string[], error?: string, outOfInputs?: boolean, timedOut?: boolean}}
 */
function runSilently(workspace, inputs) {
    const generator = javascript.javascriptGenerator;
    const previousTrap = generator.INFINITE_LOOP_TRAP;
    generator.INFINITE_LOOP_TRAP = 'if (--__eafRun.loops < 0 || Date.now() > __eafRun.deadline) throw __eafRun.stop;\n';
    let code;
    try {
        code = generator.workspaceToCode(workspace);
    } finally {
        generator.INFINITE_LOOP_TRAP = previousTrap;
    }

    const lines = [];
    const queue = [...inputs];
    const stop = new Error('stopped');
    const noInput = new Error('no input');
    const state = { loops: SILENT_RUN_MAX_LOOPS, deadline: Date.now() + SILENT_RUN_MAX_MS, stop };
    const previousPrompt = window.prompt;
    const previousLog = console.log;
    window.prompt = () => {
        if (!queue.length) throw noInput;
        return queue.shift();
    };
    console.log = (...args) => lines.push(args.map(String).join(' '));
    try {
        new Function('__eafRun', code)(state);
        return { lines };
    } catch (error) {
        if (error === stop) return { lines, timedOut: true };
        if (error === noInput) return { lines, outOfInputs: true };
        return { lines, error: error?.message || String(error) };
    } finally {
        window.prompt = previousPrompt;
        console.log = previousLog;
    }
}

// Output panel management
let outputLineCount = 0;

function clearOutput() {
    const outputPanel = document.getElementById("outputPanel");
    outputPanel.innerHTML = '';
    outputLineCount = 0;
}

function appendOutput(text) {
    const outputPanel = document.getElementById("outputPanel");
    outputPanel.setAttribute('tabindex', '-1');

    // Split by newlines if the text contains multiple lines
    const lines = text.toString().split('\n');

    lines.forEach(line => {
        outputLineCount++;

        const lineDiv = document.createElement('div');
        lineDiv.className = 'output-line';
        lineDiv.setAttribute('data-output-line', outputLineCount);

        const lineNumber = document.createElement('div');
        lineNumber.className = 'output-line-number';
        lineNumber.textContent = outputLineCount;

        const lineContent = document.createElement('div');
        lineContent.className = 'output-line-content';
        lineContent.textContent = line;

        lineDiv.appendChild(lineNumber);
        lineDiv.appendChild(lineContent);
        outputPanel.appendChild(lineDiv);
    });

    // Auto-scroll to bottom
    outputPanel.scrollTop = outputPanel.scrollHeight;
}

function setupOutputCapture() {
    // Save original console.log
    const originalLog = console.log;

    // Override console.log
    console.log = function(...args) {
        // Call original console.log
        originalLog.apply(console, args);

        // Append to output panel
        const output = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, null, 2);
                } catch (e) {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');

        appendOutput(output);
    };

    // Return a function to restore the original console.log
    return function restoreConsole() {
        console.log = originalLog;
    };
}

// async function openRouterChat({
//                                   apiKey,
//                                   model,
//                                   messages,
//                                   siteUrl,
//                                   siteName,
//                                   extra = {},
//                                   signal
//                               }) {
//     if (!apiKey) throw new Error("Missing apiKey");
//     if (!model) throw new Error("Missing model");
//     if (!Array.isArray(messages)) throw new Error("messages must be an array");
//
//     const headers = {
//         "Authorization": `Bearer ${apiKey}`,
//         "Content-Type": "application/json",
//     };
//     if (siteUrl) headers["HTTP-Referer"] = siteUrl;
//     if (siteName) headers["X-Title"] = siteName;
//
//     const body = {
//         model,
//         messages,
//         ...extra, // e.g. { temperature: 0.2, max_tokens: 512 }
//     };
//
//     const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
//         method: "POST",
//         headers,
//         body: JSON.stringify(body),
//         signal
//     });
//
//     if (!res.ok) {
//         const text = await res.text().catch(() => "");
//         throw new Error(`OpenRouter error ${res.status}: ${text || res.statusText}`);
//     }
//
//     const json = await res.json();
//     // Typical shape: { id, choices: [{ message: { role, content } }], ... }
//     return json;
// }
//
//
// document.addEventListener('DOMContentLoaded', () => {
//     const baiBtn = document.getElementById('baiButton');
//     if (baiBtn) {
//         baiBtn.addEventListener('click', () => {
//             const pb = new PromptBuilder({model: 'x-ai/grok-4-fast:free', includeSchema: true, includeFewShot: false });
//             const ib = new InputBuilder(window.workspace, {
//                 includeXML: true,
//                 includeVariables: true,
//                 includeBlocks: true,
//                 includeTypeCatalog: true,
//                 trimBlocks: true,
//                 maxHops: 2
//             });
//             const input = ib.buildFromCursor("COMPREHEND");
//             const messages = pb.buildMessages({ mode: "COMPREHEND", input});
//             // console.log("NEW PROMPT: ", messages);
//             const payload = pb.buildChatPayload({ mode: "COMPREHEND", input, includeFewShot: false });
//             console.log("NEW PROMPT PAYLOAD: ", JSON.stringify(payload));
//
//
//             const agent = new AgentActor(workspace, {
//                 replaceExistingChild: true,   // allow replacing an already-filled socket
//                 trackIdempotency:   true,     // ignore duplicate patches with same idempotencyKey
//                 defaultGroupPrefix: "ai-patch",
//                 allowDelete:        true,
//                 recordUndo:         true,
//             });
//
//             // TODO: call api
//             const llmResponse = ''; // get response here
//
//             // const llmResponse = {
//             //     "focus": { "blockId": "set1", "connection": null },
//             //     "comprehension": {
//             //         "summary": "variables_set(id:set1) intends to initialize count(counterVar) before a loop, but VALUE is empty. Later variables_set(id:inc1) increments count each iteration.",
//             //         "blockType": "variables_set",
//             //         "keyFields": { "VAR": "counterVar" },
//             //         "upstream": [],
//             //         "downstream": ["rep1", "p1", "inc1", "add1", "g10", "one1"],
//             //         "runtimeNotes": ["With VALUE missing, add1 computes NaN for count."]
//             //     },
//             //     "editGuidance": { "suggestions": [] },
//             //     "diagnostics": {
//             //         "structural": [
//             //             { "message": "Missing VALUE input on variables_set(id:set1) for variable count(counterVar).", "relatedIds": ["set1"], "severity": "error" }
//             //         ],
//             //         "logic": [],
//             //         "proposedFixes": [
//             //             {
//             //                 "title": "Initialize count to 0 at set1.VALUE",
//             //                 "rationale": "Prevents NaN when incrementing count in add1; common beginner default.",
//             //                 "patch": {
//             //                     "idempotencyKey": "fix-set1-missing-value-to-0",
//             //                     "operations": [
//             //                         { "op": "createBlock", "blockType": "math_number", "newBlockId": "init0", "fields": { "NUM": 0 }, "position": { "x": 110, "y": 50 } },
//             //                         { "op": "connect", "parentConn": { "blockId": "set1", "kind": "INPUT", "inputName": "VALUE" }, "childConn": { "blockId": "init0", "kind": "OUTPUT", "inputName": null } }
//             //                     ]
//             //                 }
//             //             }
//             //         ]
//             //     },
//             //     "debugValueProbe": {
//             //         "variable": "count",
//             //         "valueAtFocus": "undefined (VALUE missing)",
//             //         "explanation": "At set1, count lacks a numeric start; variables_get(id:g10) + 1 later yields NaN."
//             //     },
//             //     "voiceLine": "I found a missing value at set1. Shall I set count to zero so the loop works?"
//             // };
//
//             const result = agent.applyAllProposedFixes(llmResponse);
//             if (result.applied) {
//                 console.log("Suggestion applied. Created IDs:", result.createdIds);
//             } else {
//                 console.warn("No suggestion applied:", result.errors);
//             }
//         });
//     }
// });
//
