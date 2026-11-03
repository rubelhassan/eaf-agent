/**
 * The app's output manager: navigation speech, the assistant voice and sound cues on one timeline.
 * Its settings are remembered per browser.
 */
const OUTPUT_KEY = 'eaf.output';

// The built-in AI voice (Kristin). Its engine is an ES module, so index.html hands it over with aiVoiceEngine.set.
const aiVoiceEngine = (() => {
    let set;
    const engine = new Promise((resolve) => (set = resolve));
    return {
        set,
        synth: {
            ready: async () => (await engine).ready(),
            synthesize: async (text, options) => (await engine).synthesize(text, options),
        },
        voice: null,
    };
})();

const CUE_LABELS = {
    aiTurn: 'Assistant speaks',
    sent: 'Message sent',
    listeningOn: 'Listening on',
    listeningOff: 'Listening off',
    blocked: 'Blocked',
    error: 'Error',
    connected: 'Connected',
    rejected: 'Rejected',
    enteredStack: 'Entered a stack',
    leftStack: 'Left a stack',
};

// Kristin's engine files: missing, or a failed load, shows teachers how to set her up.
const KRISTIN_FILE = './models/tts/sherpa-onnx-wasm-main-tts.wasm';
// null until the check answers.
const kristin = { available: null, changed: () => {} };

function setupOutput(workspace) {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(OUTPUT_KEY) || '{}');
    } catch (e) { /* storage unavailable: defaults */ }
    let output = null;
    output = createOutputManager({
        // One locked US English system voice for navigation; the assistant is Kristin, or that voice without her.
        systemVoice: systemVoice(),
        aiVoice: aiVoiceEngine.voice = preferPageVoice({
            page: pageVoice({ synth: aiVoiceEngine.synth }),
            native: nativeAiVoice(),
            onPageFailed: () => {
                kristin.available = false;
                kristin.changed();
            },
        }),
        liveRegion: () => document.getElementById('blockReader'),
        aiLiveRegion: () => document.getElementById('assistantReader'),
        settings: { ...DEFAULT_OUTPUT_SETTINGS, ...saved },
    });
    setOutputManager(output);
    watchOperationCues(workspace, output);
    setupOutputSettings(output);
    bindTypingEcho({ document, output });
    return output;
}

function setupOutputSettings(output) {
    const $ = (id) => document.getElementById(id);
    const save = (partial) => {
        output.setSettings(partial);
        try {
            localStorage.setItem(OUTPUT_KEY, JSON.stringify(output.settings()));
        } catch (e) { /* applied, not remembered */ }
    };
    const s = output.settings();

    const disclosure = $('soundSettingsBtn');
    disclosure.addEventListener('click', () => {
        const open = disclosure.getAttribute('aria-expanded') !== 'true';
        disclosure.setAttribute('aria-expanded', String(open));
        $('soundSettings').hidden = !open;
    });

    // Teachers see why the assistant uses the system voice: Kristin isn't set up, or failed to load.
    const teacher = ['teacher', 'author'].some((k) => new URLSearchParams(location.search).get(k) === '1');
    const showKristin = () => {
        $('kristinHint').hidden = !teacher || kristin.available !== false;
    };
    kristin.changed = showKristin;
    fetch(KRISTIN_FILE, { method: 'HEAD' }).then((r) => {
        kristin.available = r.ok;
        showKristin();
    }).catch(() => {
        kristin.available = false;
        showKristin();
    });

    const bindSelect = (id, key, parse = (v) => v) => {
        const select = $(id);
        select.value = String(s[key] ?? '');
        select.addEventListener('change', () => save({ [key]: parse(select.value) }));
        return select;
    };
    bindSelect('systemOutputSelect', 'systemOutput').addEventListener('change', (e) => {
        output.say({ source: 'system', text: e.target.value === 'systemVoice' ?
            'Navigation is spoken by the built-in voice.' : 'Navigation goes to your screen reader.' });
    });
    bindSelect('systemRateSelect', 'systemRate', Number);
    bindSelect('aiRateSelect', 'aiRate', Number);
    bindSelect('typingEchoSelect', 'typingEcho');
    // On the screen reader route the assistant's voice and speed aren't used.
    const showAiRoute = () => {
        const sr = output.settings().aiOutput === 'screenReader';
        $('aiRateSelect').disabled = sr;
    };
    showAiRoute();
    bindSelect('aiOutputSelect', 'aiOutput').addEventListener('change', (e) => {
        showAiRoute();
        if (e.target.value !== 'screenReader') aiVoiceEngine.voice?.ready();
        output.say({ source: 'ai', kind: 'answer', text: e.target.value === 'screenReader' ?
            'Assistant replies go to your screen reader.' : 'The assistant talks in its own voice.' });
    });
    bindSelect('cueVolumeSelect', 'cueVolume');

    const cuesToggle = $('cuesToggle');
    const showCues = () => {
        cuesToggle.setAttribute('aria-checked', String(output.settings().cues));
        $('cuesState').textContent = output.settings().cues ? 'On' : 'Off';
    };
    showCues();
    cuesToggle.addEventListener('click', () => {
        save({ cues: !output.settings().cues });
        showCues();
    });

    const cueSelect = $('cuePreviewSelect');
    cueSelect.append(...Object.keys(EARCONS).map(name => new Option(CUE_LABELS[name] || name, name)));
    $('playCueBtn').addEventListener('click', () => output.cue(cueSelect.value));
    $('hearAiVoiceBtn').addEventListener('click', () => output.say({
        source: 'ai', kind: 'answer', text: "Hi, I'm your coding helper. This is how I sound when I talk to you.",
    }));
}
