/**
 * Guide panel: the student guide (Settings, everyone) or the teacher guide (?teacher=1).
 * Loads docs/<name>-guide.html into the right column in place of Output and Code, with
 * numbered markers on the screenshots (positions from docs/guide-markers.json, written by
 * docs/capture-guide.js). Maximize fills the window; Escape or Minimize brings it back to the column.
 */
(function () {
    const TITLES = { student: 'Student guide', teacher: 'Teacher guide' };
    const loaded = {};
    let markersLoaded = null;

    function load(name) {
        markersLoaded ||= fetch('docs/guide-markers.json', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
        loaded[name] ||= Promise.all([
            fetch(`docs/${name}-guide.html`, { cache: 'no-store' }).then((r) => r.text()),
            markersLoaded,
        ]);
        return loaded[name];
    }

    function placeMarkers(body, markers) {
        for (const figure of body.querySelectorAll('.guide-shot[data-shot]')) {
            for (const { n, box } of markers[figure.dataset.shot]?.markers || []) {
                const outline = document.createElement('span');
                outline.className = 'guide-box';
                Object.assign(outline.style, { left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` });
                const marker = document.createElement('span');
                marker.className = 'guide-marker';
                marker.textContent = String(n);
                Object.assign(marker.style, { left: `${box.x}%`, top: `${box.y}%` });
                // Pictures are explained by the numbered list under them; the drawing is decoration.
                outline.setAttribute('aria-hidden', 'true');
                marker.setAttribute('aria-hidden', 'true');
                figure.append(outline, marker);
            }
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const panel = document.getElementById('teacherGuide');
        const column = panel?.closest('.execution-panel');
        const title = document.getElementById('guideTitle');
        const body = document.getElementById('guideBody');
        const size = document.getElementById('guideSizeBtn');
        const closeBtn = document.getElementById('guideCloseBtn');
        if (!panel) return;
        let current = null;

        const label = () => (TITLES[current] || 'guide').toLowerCase();
        const setMax = (max) => {
            panel.classList.toggle('guide-max', max);
            size.setAttribute('aria-label', `${max ? 'Minimize' : 'Maximize'} the ${label()}`);
            size.title = max ? 'Minimize' : 'Maximize';
            size.querySelector('i').className = `fas ${max ? 'fa-down-left-and-up-right-to-center' : 'fa-up-right-and-down-left-from-center'}`;
        };
        const close = () => {
            setMax(false);
            panel.hidden = true;
            column.classList.remove('guide-open');
            document.getElementById('settingsButton').focus();
        };

        async function open(name) {
            window.eafSettings?.close();
            column.classList.add('guide-open');
            panel.hidden = false;
            if (current !== name) {
                current = name;
                title.textContent = TITLES[name];
                closeBtn.setAttribute('aria-label', `Close the ${label()}`);
                setMax(panel.classList.contains('guide-max'));
                const [html, markers] = await load(name);
                body.innerHTML = html;
                placeMarkers(body, markers);
                body.scrollTop = 0;
            }
            title.focus();
        }

        for (const button of document.querySelectorAll('[data-guide]')) {
            button.addEventListener('click', () => open(button.dataset.guide));
        }
        size.addEventListener('click', () => setMax(!panel.classList.contains('guide-max')));
        closeBtn.addEventListener('click', close);
        panel.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (panel.classList.contains('guide-max')) setMax(false);
            else close();
        });
    });
})();
