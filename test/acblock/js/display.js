/**
 * Display settings: the focus magnifier's level, remembered per browser and kept in step with its keys.
 */
const DISPLAY_KEY = 'eaf.display';

function setupDisplaySettings(magnifier) {
    const select = document.getElementById('magnifierSelect');
    if (!magnifier || !select) return;
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}');
    } catch (e) { /* storage unavailable: off */ }
    magnifier.setLevel(saved.magnifier || 0);
    select.value = String(magnifier.level());
    select.addEventListener('change', () => magnifier.setLevel(Number(select.value)));
    magnifier.onChange((level) => {
        select.value = String(level);
        try {
            localStorage.setItem(DISPLAY_KEY, JSON.stringify({ magnifier: level }));
        } catch (e) { /* applied, not remembered */ }
    });
}
