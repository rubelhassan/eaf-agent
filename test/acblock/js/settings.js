/**
 * Settings disclosure panel anchored under the gear button in the exec header.
 * Holds user preferences; item behaviour (e.g. Log payload) is wired where its dependencies live.
 */
(function () {
    function setSettingsOpen(open) {
        const panel = document.getElementById('settingsPanel');
        if (!panel || panel.hidden === !open) return;
        panel.hidden = !open;
        document.getElementById('settingsButton').setAttribute('aria-expanded', String(open));
        if (open) {
            const note = document.getElementById('settingsNote');
            if (note) note.textContent = '';
            const first = panel.querySelector('button, input, select');
            if (first) first.focus();
        }
    }

    // Dialogs opened from the panel close it first (it sits above them and takes Escape).
    window.eafSettings = { close: () => setSettingsOpen(false) };

    document.addEventListener('DOMContentLoaded', () => {
        const button = document.getElementById('settingsButton');
        const panel = document.getElementById('settingsPanel');
        if (!button || !panel) return;

        button.addEventListener('click', () => setSettingsOpen(panel.hidden));

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.settings')) setSettingsOpen(false);
        });

        // Capture phase so Escape closes only the settings panel, not the assistant panel too.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || panel.hidden) return;
            e.preventDefault();
            e.stopPropagation();
            setSettingsOpen(false);
            button.focus();
        }, true);
    });
})();
