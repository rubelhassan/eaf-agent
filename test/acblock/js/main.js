// list block program xml
const PROGRAMS = [
    { "id": "Program1", "label": "Program 1", "file": "xml/tasks/task-1.xml" },
    { "id": "Program2", "label": "Program 2 (Incomplete)",   "file": "xml/tasks/task-2.xml" },
    { "id": "Program2Comp", "label": "Program 2 (Complete)",    "file": "xml/tasks/task-2-complete.xml" },
    // { "id": "Test1", "label": "Test 1",    "file": "xml/tests/test1.xml" },
    // { "id": "Test2", "label": "Test 2",    "file": "xml/tests/test2.xml" },
];

function populateProgramsToDom() {
    const select = document.getElementById('programSelect');
    select.innerHTML = '<option value="Default">None — select a program…</option>';
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


function loadXmlToWorkspace(workspace, xmlString) {
    try {
        const textToDom = (Blockly.Xml.textToDom || Blockly.utils.xml.textToDom);
        const xml = textToDom(xmlString);
        Blockly.Xml.clearWorkspaceAndLoadFromXml(xml.documentElement || xml, workspace);
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

// Global instructions overlay manager
let instructionsManager = null;

function initWorkspace() {
    // load program as html select items
    populateProgramsToDom();

    // Initialize instructions overlay
    instructionsManager = window.initInstructionsOverlay();

    // Set initial button state based on default selection (Default)
    const select = document.getElementById('programSelect');
    const initialSelection = select.value; // This will be "Default"
    if (instructionsManager) {
        instructionsManager.setProgramId(initialSelection);
    }

    // Override the text_print block to use console.log instead of alert
    javascript.javascriptGenerator.forBlock['text_print'] = function(block, generator) {
        const msg = generator.valueToCode(block, 'TEXT', javascript.Order.NONE) || "''";
        return 'console.log(' + msg + ');\n';
    };

    // Blockly Workspace Initialization
    const workspace = Blockly.inject('blocklyDiv', {
        toolbox: toolboxConfig,
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

    workspace.allowedTypeCatalog = allowedTypeCatalog(toolboxConfig);
    window.workspace = workspace;

    let nav = new NavigationController();
    nav.init();
    nav.addWorkspace(workspace);

    const keyOverlay = new KeyOverlay({ hideDelayMs: 5000 });
    keyOverlay.attach();

    document.getElementById("runButton").addEventListener("click", () => {
        // Close Blockly Pilot panel if open
        if (window.blocklyPilot && window.blocklyPilot.state.panelVisible) {
            window.blocklyPilot.close();
        }

        // Clear output panel
        clearOutput();

        // Setup output capture only when running code
        const restoreConsole = setupOutputCapture();

        generateCode(Blockly.getMainWorkspace());
        try {
            eval(document.getElementById("codeOutput").textContent);
        } catch (error) {
            appendOutput("Error: " + error.message);
        } finally {
            // Restore original console.log after execution
            restoreConsole();
        }
    });

    document.getElementById("languageSelect").addEventListener("change", generateCode);

    // Auto-load program when selection changes
    document.getElementById("programSelect").addEventListener("change", async () => {
        const select = document.getElementById("programSelect");
        const selectedId = select.value;

        // Update instructions manager with current program
        if (instructionsManager) {
            instructionsManager.setProgramId(selectedId);
        }

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

    // Info button to show instructions
    document.getElementById("showInstructions")?.addEventListener("click", () => {
        instructionsManager?.show();
    });

    // auto select & load program if query param is provided
    autoLoadProgramFromQuery(workspace);
    // renderKeyboardHints(null);
}

function generateCode() {
    const language = document.getElementById("languageSelect").value;
    let code;
    switch (language) {
        case "javascript":
            code = javascript.javascriptGenerator.workspaceToCode(Blockly.getMainWorkspace());
            break;
        case "python":
            code = python.pythonGenerator.workspaceToCode(Blockly.getMainWorkspace());
            break;
        case "php":
            code = php.phpGenerator.workspaceToCode(Blockly.getMainWorkspace());
            break;
        case "lua":
            code = lua.luaGenerator.workspaceToCode(Blockly.getMainWorkspace());
            break;
        case "dart":
            code = dart.dartGenerator.workspaceToCode(Blockly.getMainWorkspace());
            break;
        case "xml":
            const xmlDom = Blockly.Xml.workspaceToDom(Blockly.getMainWorkspace());
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
