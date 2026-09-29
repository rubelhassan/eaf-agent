/**
 * Teacher guide panel (?teacher=1): loads docs/teacher-guide.html into the right
 * column in place of Output and Code, with numbered markers on the screenshots
 * (positions from docs/guide-markers.json, written by docs/capture-guide.js).
 * Maximize fills the window; Escape or Minimize brings it back to the column.
 */
(function () {
    let loaded = null;

    async function load(body) {
        if (!loaded) {
            loaded = Promise.all([
                fetch('docs/teacher-guide.html', { cache: 'no-store' }).then((r) => r.text()),
                fetch('docs/guide-markers.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
            ]).then(([html, markers]) => {
                body.innerHTML = html;
                placeMarkers(body, markers);
            });
        }
        return loaded;
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
        const open = document.getElementById('teacherGuideBtn');
        const size = document.getElementById('guideSizeBtn');
        if (!panel || !open) return;

        const setMax = (max) => {
            panel.classList.toggle('guide-max', max);
            size.setAttribute('aria-label', max ? 'Minimize the teacher guide' : 'Maximize the teacher guide');
            size.title = max ? 'Minimize' : 'Maximize';
            size.querySelector('i').className = `fas ${max ? 'fa-down-left-and-up-right-to-center' : 'fa-up-right-and-down-left-from-center'}`;
        };
        const close = () => {
            setMax(false);
            panel.hidden = true;
            column.classList.remove('guide-open');
            document.getElementById('settingsButton').focus();
        };

        open.addEventListener('click', async () => {
            window.eafSettings?.close();
            column.classList.add('guide-open');
            panel.hidden = false;
            await load(document.getElementById('guideBody'));
            document.getElementById('guideTitle').focus();
        });
        size.addEventListener('click', () => setMax(!panel.classList.contains('guide-max')));
        document.getElementById('guideCloseBtn').addEventListener('click', close);
        panel.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (panel.classList.contains('guide-max')) setMax(false);
            else close();
        });
    });
})();
