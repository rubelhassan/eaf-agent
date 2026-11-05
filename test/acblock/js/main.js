// list block program xml
const PROGRAMS = [
    { id: 'DemoBridge', label: 'Demo: Question Blocks', file: 'xml/tasks/question-demo-beans.xml', serverTask: true },
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

/** The toolbox for the mode, with the current theme's category styles and symbols. */
function themedToolbox(teacherMode) {
    return window.eafThemes ? window.eafThemes.decorateToolbox(toolboxFor(teacherMode)) : toolboxFor(teacherMode);
}

/** Settings → Dark mode: the dark or light theme, remembered on this device. */
function setupThemeSwitch(workspace) {
    const toggle = document.getElementById('darkModeToggle');
    const state = document.getElementById('darkModeState');
    if (!toggle || !window.eafThemes) return;
    const sync = () => {
        const dark = window.eafThemes.current() === 'dark';
        toggle.setAttribute('aria-checked', String(dark));
        state.textContent = dark ? 'On' : 'Off';
    };
    toggle.addEventListener('click', () => {
        window.eafThemes.apply(window.eafThemes.current() === 'dark' ? 'light' : 'dark', {
            workspace, remember: true, toolbox: () => toolboxFor(getPolicy(workspace).teacherMode),
        });
        sync();
    });
    sync();
}

/** Teacher mode (only offered with ?teacher=1): toolbox, task snapshot, activity, export/import. */
/**
 * Header and Settings keys. Ctrl+Shift+P (teacher mode): to Publish. Ctrl+Shift+S: Settings, on its first control.
 * In the header buttons W/A and S/D move to the previous and next one; in Settings W and S move between controls and
 * A and D change a list's choice. Escape goes back to the editor. Letters in a text field are typing.
 */
function setupHeaderKeys(workspace) {
    const $ = (id) => document.getElementById(id);
    const HEADER = ['audioToggle', 'navToggle', 'settingsButton', 'runButton', 'programSelect', 'showShortcuts',
        'publishTaskBtn', 'discardTaskBtn', 'resetTaskBtn'];
    const visible = (el) => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0;
    const headerItems = () => HEADER.map($).filter(visible);
    const settingsItems = () => [...$('settingsPanel').querySelectorAll('button, select, input, [tabindex="0"]')]
        .filter((el) => visible(el) && !el.disabled);
    const typing = (el) => el instanceof Element && !!el.closest('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]');
    const nameOf = (el) => el.getAttribute('aria-label') || el.labels?.[0]?.textContent.trim() || el.textContent.trim().replace(/\s+/g, ' ');
    // The built-in voice says where focus landed; a screen reader hears the focus itself.
    const say = (text) => {
        const output = window.eafOutput;
        if (text && output?.settings?.().systemOutput === 'systemVoice') output.say({ source: 'system', kind: 'navigation', text });
    };
    const focus = (el) => {
        if (!el) return;
        el.focus();
        say(nameOf(el));
    };
    const toEditor = () => {
        window.eafSettings?.close();
        workspace.getParentSvg()?.focus();
    };
    const step = (items, el, by) => {
        const at = items.indexOf(el);
        return items[Math.max(0, Math.min(items.length - 1, (at < 0 ? 0 : at) + by))];
    };
    const settingsOpen = () => !$('settingsPanel').hidden;

    window.addEventListener('keydown', (e) => {
        const target = document.activeElement;
        const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
        if (ctrlShift && e.code === 'KeyS') {
            e.preventDefault();
            e.stopPropagation();
            if (!settingsOpen()) $('settingsButton').click();
            focus(settingsItems()[0]);
            return;
        }
        if (ctrlShift && e.code === 'KeyP') {
            e.preventDefault();
            e.stopPropagation();
            const publish = $('publishTaskBtn');
            if (getPolicy(workspace).teacherMode && visible(publish)) focus(publish);
            else window.eafOutput?.say({ source: 'system', text: 'Publish shows in teacher mode with a task from the server.' });
            return;
        }
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        const inSettings = settingsOpen() && $('settingsPanel').contains(target);
        const inHeader = HEADER.includes(target?.id);
        if (!inSettings && !inHeader) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            toEditor();
            return;
        }
        if (typing(target) || e.shiftKey) return;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (!['w', 'a', 's', 'd'].includes(key)) return;
        e.preventDefault();
        e.stopPropagation();
        if (inHeader) {
            focus(step(headerItems(), target, key === 'w' || key === 'a' ? -1 : 1));
        } else if (key === 'w' || key === 's') {
            focus(step(settingsItems(), target, key === 'w' ? -1 : 1));
        } else if (target.tagName === 'SELECT') {
            // A and D change a list's choice, like Up and Down.
            const index = Math.max(0, Math.min(target.options.length - 1, target.selectedIndex + (key === 'a' ? -1 : 1)));
            if (index !== target.selectedIndex) {
                target.selectedIndex = index;
                target.dispatchEvent(new Event('change', { bubbles: true }));
                say(target.options[index].textContent);
            }
        }
    }, true);
}

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

/** The role badge above the gear: Teacher in teacher mode, else Student (also on the plain learner page). */
function showRoleBadge(teacher) {
    // Questions are ordinary blocks in teacher mode (nothing vanishes), so make the role obvious.
    const badge = document.getElementById('roleBadge');
    badge.hidden = false;
    const icon = document.createElement('i');
    icon.className = `fas ${teacher ? 'fa-chalkboard-user' : 'fa-user-graduate'}`;
    icon.setAttribute('aria-hidden', 'true');
    badge.replaceChildren(icon, teacher ? ' Teacher' : ' Student');
    badge.className = `role-badge role-badge-${teacher ? 'teacher' : 'student'}`;
}

function setupTeacherMode(workspace, runOnRun) {
    const params = new URLSearchParams(window.location.search);
    // ?author=1 is the old name of the teacher URL.
    if (params.get('teacher') !== '1' && params.get('author') !== '1') {
        showRoleBadge(false);
        return;
    }
    const modeRow = document.getElementById('teacherModeRow');
    const toolsRow = document.getElementById('teacherToolsRow');
    const toggle = document.getElementById('teacherModeToggle');
    const state = document.getElementById('teacherModeState');
    const wholePlan = document.getElementById('wholePlanToggle');
    const editMode = document.getElementById('editModeSelect');
    const voiceFallback = document.getElementById('voiceFallbackToggle');
    modeRow.hidden = false;

    const render = () => {
        const on = getPolicy(workspace).teacherMode;
        toggle.setAttribute('aria-checked', String(on));
        state.textContent = on ? 'On' : 'Off';
        toolsRow.hidden = !on;
        // Teacher tools have the task's Edit mode; the learner's own control would show the same choice twice.
        document.getElementById('learnerEditModeRow').hidden = on;
        wholePlan.setAttribute('aria-checked', String(getPolicy(workspace).wholePlan));
        editMode.value = getPolicy(workspace).editMode;
        // Whole plan is for Step-confirm; in Guided the learner does every step.
        wholePlan.setAttribute('aria-disabled', String(getPolicy(workspace).editMode === 'guided'));
        document.getElementById('wholePlanState').textContent = getPolicy(workspace).wholePlan ? 'On' : 'Off';
        voiceFallback.setAttribute('aria-checked', String(getPolicy(workspace).voiceFallback));
        document.getElementById('voiceFallbackState').textContent = getPolicy(workspace).voiceFallback ? 'On' : 'Off';
        showRoleBadge(on);
        document.getElementById('blocklyApp').setAttribute('aria-label', on ? 'Blockly workspace, teacher mode' : 'Blockly workspace');
    };
    toggle.addEventListener('click', () => setPolicy(workspace, { teacherMode: !getPolicy(workspace).teacherMode }));
    editMode.addEventListener('change', () => setPolicy(workspace, { editMode: editMode.value }));
    wholePlan.addEventListener('click', () => {
        if (wholePlan.getAttribute('aria-disabled') === 'true') return;
        setPolicy(workspace, { wholePlan: !getPolicy(workspace).wholePlan });
    });
    voiceFallback.addEventListener('click', () => setPolicy(workspace, { voiceFallback: !getPolicy(workspace).voiceFallback }));
    onPolicyChange(workspace, (next, previous) => {
        if (next.teacherMode !== previous.teacherMode) workspace.updateToolbox(themedToolbox(next.teacherMode));
        render();
    });

    document.getElementById('exportTaskBtn').addEventListener('click', () => {
        downloadXml(QuestionBlock.cleanTaskXml(workspace), 'task');
    });
    // Teacher-only: tests of the whole program, used when assessing a learner's work.
    const testsDialog = new QuestionBlock.TaskTestsDialog(workspace, {
        onRun: runOnRun, onSave: () => publication?.changed(), execute: runHeadless,
    });
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
        workspace.workTask = chosen.name;
    });
    // Opening the teacher URL starts in teacher mode.
    setPolicy(workspace, { teacherMode: true });
    render();
}

/**
 * Edit mode for the learner (Settings): starts at the task's setting and may be changed in a practice; off in a quiz,
 * where the assistant doesn't change programs.
 */
function setupLearnerEditMode(workspace) {
    const select = document.getElementById('learnerEditModeSelect');
    const hint = document.getElementById('learnerEditModeHint');
    if (!select) return;
    const render = () => {
        const { editMode, activity } = getPolicy(workspace);
        const quiz = activity === 'quiz';
        select.value = editMode;
        select.disabled = quiz;
        hint.textContent = quiz ? 'Off in a quiz: the assistant does not change programs there.' : '';
        hint.hidden = !quiz;
    };
    select.addEventListener('change', () => setPolicy(workspace, { editMode: select.value }));
    onPolicyChange(workspace, render);
    render();
}

/** The lab uses one Activity control for learners and teachers. */
function setupActivity(workspace) {
    const select = document.getElementById('activitySelect');
    const render = () => { select.value = getPolicy(workspace).activity; };
    select.addEventListener('change', () => setPolicy(workspace, { activity: select.value }));
    onPolicyChange(workspace, render);
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
    if (entry.serverTask && window.eafTaskServer === undefined) await waitForTaskServer();
    if (entry.serverTask && window.eafTaskServer) {
        try {
            const response = await fetch(`${window.eafTaskServer}/v1/tasks/${encodeURIComponent(id)}/latest`,
                {signal: AbortSignal.timeout(2000), cache: 'no-store'});
            if (response.ok) {
                const task = await response.json();
                if (task.taskId !== id || typeof task.taskXml !== 'string' || !validTaskXml(task.taskXml)) throw new Error('Invalid saved task');
                appendLog("Loaded the teacher's saved version.");
                return task.taskXml;
            }
        } catch (error) { /* A saved version is optional; the bundled task remains available. */ }
    }
    const res = await fetch(entry.file, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    return await res.text();
}

/** Initial query-string loads can arrive before the server health check. */
function waitForTaskServer() {
    return new Promise(resolve => {
        const done = () => { clearTimeout(timer); document.removeEventListener('eaf-task-server', done); resolve(); };
        const timer = setTimeout(done, 2000);
        document.addEventListener('eaf-task-server', done, {once: true});
    });
}

/** Validate on a disposable copy before replacing the learner's program. */
function validTaskXml(xml) {
    const copy = new Blockly.Workspace();
    Blockly.Events.disable();
    try {
        if (Blockly.utils.xml.textToDom(xml).nodeName.toLowerCase() !== 'xml') return false;
        QuestionBlock.loadTaskXml(copy, xml);
        return true;
    } catch (error) { return false; }
    finally { copy.dispose(); Blockly.Events.enable(); }
}

/** Set in init; program loads reset keyboard navigation through it. */
let navController = null;
let solvedWatcher = null;
let workspaceLoading = false;
let publication = null;

function publicationSnapshot(workspace) {
    const {activity, editMode, wholePlan, voiceFallback} = getPolicy(workspace);
    return JSON.stringify([Blockly.serialization.workspaces.save(workspace), {activity, editMode, wholePlan, voiceFallback},
        QuestionBlock.getTaskTests(workspace)]);
}

function setupTaskPublication(workspace) {
    publication = createTaskPublication({workspace, document, getPolicy, onPolicyChange, ModalForm: QuestionBlock.ModalForm,
        entry: () => findProgramById(document.getElementById('programSelect').value),
        serverUrl: () => window.eafTaskServer, snapshot: () => publicationSnapshot(workspace),
        cleanXml: () => QuestionBlock.cleanTaskXml(workspace), validateXml: validTaskXml,
        loadXml: xml => loadXmlToWorkspace(workspace, xml),
        bundledXml: async task => {
            const response = await fetch(task.file, {cache: 'no-store'});
            if (!response.ok) throw new Error('Could not load the original task.');
            return response.text();
        },
        say: text => { appendLog(text); window.eafOutput?.say({source: 'navigation', kind: 'system', text}); },
        record: (kind, data) => window.eafEvents?.record(kind, data),
    });
    window.addEventListener('pagehide', () => publication.dispose(), {once: true});
}

/** These notices follow Navigation speech, but queue instead of cutting a voice. */
function announceSolved(questions) {
    const numbers = questions.map(question => question.number);
    const last = numbers[numbers.length - 1];
    const list = numbers.length === 1 ? String(last) : `${numbers.slice(0, -1).join(', ')} and ${last}`;
    window.eafOutput?.say({source: 'navigation', kind: 'system', cue: 'solved',
        text: `${numbers.length === 1 ? 'Question' : 'Questions'} ${list} solved.`});
}

function syncSolvedWatcher(workspace) {
    const {activity, teacherMode} = getPolicy(workspace);
    if (teacherMode || activity === 'quiz') { solvedWatcher?.dispose(); solvedWatcher = null; return; }
    if (!solvedWatcher) solvedWatcher = QuestionBlock.createSolvedWatcher(workspace, {
        execute: runHeadless, onSolved: announceSolved,
        isBusy: () => workspaceLoading || workspace.isDragging?.() || window.eafApplyBusy?.(),
    });
}

function loadXmlToWorkspace(workspace, xmlString) {
    workspaceLoading = true;
    publication?.beginLoad();
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
    } finally {
        workspaceLoading = false;
        syncSolvedWatcher(workspace);
        solvedWatcher?.reset();
        publication?.loaded();
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
        toolbox: themedToolbox(false),
        theme: window.eafThemes?.blocklyTheme(),
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
    setupThemeSwitch(workspace);
    setupHeaderKeys(workspace);
    setupDisplaySettings(nav.focusMagnifier);
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
    setupActivity(workspace);
    setupLearnerEditMode(workspace);
    const run = () => runProgram(workspace, nav.speech);
    setupTeacherMode(workspace, run);
    setupTaskPublication(workspace);
    onPolicyChange(workspace, () => syncSolvedWatcher(workspace));
    syncSolvedWatcher(workspace);
    // Learners hand in their work as a file; a teacher imports it and Run assesses it.
    document.getElementById('saveWorkBtn').addEventListener('click', () => {
        const programXml = QuestionBlock.workXml(workspace);
        downloadXml(programXml, 'work');
        const save = workspace.workSave;
        if (!save) { console.warn('[work] Server connection is not ready; the file was downloaded.'); return; }
        const savedAt = new Date().toISOString();
        const task = workspace.workTask || 'untitled';
        const summary = authorshipSummary(workspace, {stackLetters: assistantView(workspace).stackLetters(),
            session: {...save.session, task, pageStartedAt: save.pageStartedAt, savedAt}});
        void save.server.work({programXml, task, savedAt, summary}).catch((error) => console.warn('[work]', error));
    });

    const keyOverlay = new KeyOverlay({ hideDelayMs: 5000 });
    keyOverlay.attach();

    document.getElementById("runButton").addEventListener("click", run);

    document.getElementById("languageSelect").addEventListener("change", () => generateCode(workspace));

    // Loads the chosen program. A mouse pick, or a pick in the opened list, loads at once and puts focus on the
    // editor's cursor (stack A, said by the navigation speech). Arrows, Home, End and letters on the closed list change
    // it on every key in Chrome and Firefox on Windows, so those only browse: Enter loads, and leaving (Tab) loads
    // without moving focus.
    const programSelect = document.getElementById("programSelect");
    let browsing = false;
    // On a Mac an arrow opens the list instead (a pick there is a change like a click), so only letters browse.
    const ARROWS_OPEN_LIST = /Mac/.test(navigator.platform);
    const BROWSE_KEYS = ARROWS_OPEN_LIST ? [] : ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    async function loadChosen({ focus }) {
        browsing = false;
        publication?.beginLoad();
        const selectedId = programSelect.value;
        if (!selectedId || selectedId === "Default") {
            // Clear workspace if no program selected
            const policy = getPolicy(workspace);
            loadXmlToWorkspace(workspace, '<xml/>');
            setPolicy(workspace, policy);
            workspace.workTask = 'untitled';
        } else {
            try {
                const xml = await fetchProgramXmlById(selectedId);
                loadXmlToWorkspace(workspace, xml);
                workspace.workTask = findProgramById(selectedId)?.file || selectedId;
            } catch (e) {
                publication?.loaded();
                console.error(e);
                alert('Could not load the selected program.');
                return;
            }
        }
        if (focus) workspace.getParentSvg()?.focus();
    }
    programSelect.addEventListener("keydown", (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            // Enter without browsing first: the program shown is already loaded; just go to it.
            if (browsing) loadChosen({ focus: true });
            else workspace.getParentSvg()?.focus();
        } else if (BROWSE_KEYS.includes(e.key) || (e.key.length === 1 && e.key !== ' ')) {
            browsing = true;
        }
    });
    programSelect.addEventListener("change", () => {
        if (!browsing) loadChosen({ focus: true });
    });
    programSelect.addEventListener("blur", () => {
        if (browsing) loadChosen({ focus: false });
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

let learnerRun = null;
// The open assistant panel hides Output and Code, so Run closes it first (index.html sets this).
let closeAssistantForRun = () => {};

/** index.html passes the assistant panel's close once the panel exists. */
function setRunClosesAssistant(close) {
    closeAssistantForRun = close;
}

/**
 * Run stops on empty questions; teachers still get their status report.
 */
async function runProgram(workspace, speech) {
    const say = (text) => {
        if (workspace.keyboardAccessibilityMode) speech.update(text);
    };
    // Like closing the panel: the conversation ends, the AI voice stops, focus returns. An offered step stays waiting.
    closeAssistantForRun();
    learnerRun ||= createLearnerRun({ workspace, say, appendOutput,
        escapeFirst: (e) => !!navController?.focusMagnifier?.takeEscape(e) });
    if (learnerRun.isRunning()) {
        await learnerRun.run();
        return;
    }
    const { teacherMode } = getPolicy(workspace);
    const gate = QuestionBlock.runGate(workspace, { locate: describeBlockLocation });
    if (gate.blocked) {
        clearOutput();
        appendOutput(gate.line);
        speech.update(gate.line);
        if (teacherMode) await showAssessment(workspace);
        return;
    }
    window.eafActivity?.noteRun();
    clearOutput();
    if (!teacherMode) {
        const warning = QuestionBlock.learnerRunWarning(workspace);
        if (warning) {
            appendOutput(`Note: ${warning}`);
            say(warning);
        }
    }

    generateCode(workspace);
    // In a worker with limits, so a loop that never ends can't freeze the page.
    await learnerRun.run();

    if (teacherMode) {
        say(await showAssessment(workspace));
    }
}

/** Shows assessment lines; the caller chooses whether its summary should be spoken. */
async function showAssessment(workspace) {
    const report = await QuestionBlock.assess(workspace, {
        execute: (inputs) => runHeadless(workspace, inputs),
        locate: describeBlockLocation,
    });
    appendOutput('Assessment');
    report.lines.forEach((line) => appendOutput(line));
    appendOutput(authorshipLine(authorshipSummary(workspace, {stackLetters: assistantView(workspace).stackLetters()}),
        window.eafOutput.aiName()));
    return report.summary || 'Assessment done.';
}

// Output panel management. It is the "Log" while it shows app messages (loaded, published, discarded) and the
// "Output" while it shows a program's run; the two never mix.
let outputLineCount = 0;
let outputMode = 'output';

function setOutputMode(mode) {
    if (mode === outputMode) return;
    outputMode = mode;
    const title = mode === 'log' ? 'Log' : 'Output';
    const heading = document.getElementById('outputTitle');
    if (heading) heading.textContent = title;
    document.getElementById('outputPanel')?.setAttribute?.('aria-label', `${title} panel`);
}

function clearLines() {
    const panel = document.getElementById("outputPanel");
    if (panel) panel.innerHTML = '';
    outputLineCount = 0;
}

/** Run starts here: the panel shows the program's output. */
function clearOutput() {
    clearLines();
    setOutputMode('output');
}

/** An app message: it replaces a program's output in view; more messages add to the log. */
function appendLog(text) {
    if (outputMode !== 'log') {
        clearLines();
        setOutputMode('log');
    }
    appendOutput(text);
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
