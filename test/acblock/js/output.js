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

function setupOutput(workspace) {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(OUTPUT_KEY) || '{}');
    } catch (e) { /* storage unavailable: defaults */ }
    let output = null;
    const current = () => output.settings();
    output = createOutputManager({
        systemVoice: systemVoice({ voice: () => current().systemVoice }),
        aiVoice: aiVoiceEngine.voice = preferPageVoice({
            page: pageVoice({ synth: aiVoiceEngine.synth }),
            native: nativeAiVoice({ voice: () => current().aiVoice, systemVoiceName: () => current().systemVoice }),
            systemPicked: () => !!current().aiVoice,
        }),
        liveRegion: () => document.getElementById('blockReader'),
        settings: { ...DEFAULT_OUTPUT_SETTINGS, ...saved },
    });
    setOutputManager(output);
    watchOperationCues(workspace, output);
    setupOutputSettings(output);
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

    const fillVoices = () => {
        const voices = localVoices();
        for (const [id, key, first] of [['systemVoiceSelect', 'systemVoice', 'Default'], ['aiVoiceSelect', 'aiVoice', 'Kristin (built in)']]) {
            const select = $(id);
            select.innerHTML = '';
            select.append(new Option(first, ''), ...voices.map(v => new Option(v.name, v.name)));
            select.value = output.settings()[key] || '';
        }
    };
    fillVoices();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', fillVoices);

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
    bindSelect('systemVoiceSelect', 'systemVoice', (v) => v || null);
    bindSelect('systemRateSelect', 'systemRate', Number);
    bindSelect('aiVoiceSelect', 'aiVoice', (v) => v || null);
    bindSelect('aiRateSelect', 'aiRate', Number);
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
