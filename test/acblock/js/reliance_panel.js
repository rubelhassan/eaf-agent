const RELIANCE_GROUPS = [
    {key: 'student', label: 'Student'}, {key: 'assisted', label: 'AI-assisted'}, {key: 'created', label: 'AI-created'},
];

/** The denominator is only blocks added or changed for this submission. @param {!Object} summary */
function relianceData(summary) {
    const blocks = (summary.blocks || []).filter(block => block.added || block.history?.length).slice().sort((a, b) =>
        String(a.stack || '').localeCompare(String(b.stack || ''), undefined, {numeric: true}) || (a.number || 0) - (b.number || 0));
    const counts = {student: 0, assisted: 0, created: 0};
    for (const block of blocks) counts[block.kind === 'created' ? 'created' : block.kind === 'assisted' ? 'assisted' : 'student']++;
    const fractions = RELIANCE_GROUPS.map(({key}, index) => ({key, index, value: blocks.length ? counts[key] * 100 / blocks.length : 0}));
    const percentages = Object.fromEntries(fractions.map(({key, value}) => [key, Math.floor(value)]));
    const remainder = blocks.length ? 100 - Object.values(percentages).reduce((sum, value) => sum + value, 0) : 0;
    fractions.sort((a, b) => (b.value % 1) - (a.value % 1) || a.index - b.index)
        .slice(0, remainder).forEach(({key}) => percentages[key]++);
    return {blocks, percentages};
}

/** @param {!Object} block @returns {string} */
function relianceContext(block) {
    const history = block.history || [];
    const ai = history.filter(entry => entry.by === 'ai');
    const contexts = [];
    if (block.kind === 'learner' && !ai.length) contexts.push('self');
    if (ai.some(entry => entry.type === 'guidance')) contexts.push('guided');
    if (ai.some(entry => entry.type === 'edit' || entry.type === 'debug')) contexts.push('step-confirm');
    if (block.kind === 'created' || ai.some(entry => entry.action === 'create')) contexts.push('created');
    if ((block.kind !== 'learner' && history.some(entry => entry.by === 'learner' && entry.action !== 'create')) ||
        (block.kind !== 'created' && ai.some(entry => entry.action === 'field'))) contexts.push('edited');
    return contexts.join(', ');
}

/** The host supplies names and data; this panel never reads a program or calls a service. @param {!Object} options */
function createReliancePanel({document: doc, blockName, assistantName = () => 'Neon'}) {
    const panel = doc.getElementById('reliancePanel');
    const container = panel.closest('.code-container');
    const figures = doc.getElementById('relianceFigures');
    const note = doc.getElementById('relianceNote');
    const size = doc.getElementById('relianceSizeBtn');
    const code = doc.getElementById('codeOutput');
    const language = doc.getElementById('languageSelect');
    const title = doc.getElementById('codeHeader');
    let active = false; let submission = null; let maximized = false;

    function node(tag, text, className) {
        const element = doc.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    }
    function svgNode(tag, attrs = {}) {
        const element = doc.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
        return element;
    }
    function mark() {
        const svg = svgNode('svg', {viewBox: '0 0 16 16', width: 18, height: 18, 'aria-hidden': 'true', class: 'reliance-mark'});
        svg.append(svgNode('circle', {cx: 8, cy: 8, r: 7, fill: '#fff', stroke: '#7C3AED'}),
            svgNode('rect', {x: 2.5, y: 4, width: 11, height: 8, rx: 3, fill: '#1f2a44'}));
        for (const cx of [5.5, 10.5]) svg.append(svgNode('circle', {cx, cy: 7.4, r: 1.3, fill: '#8ff0b4'}));
        return svg;
    }
    function cell(row, text, {header = false} = {}) {
        const element = node(header ? 'th' : 'td', text);
        if (header) element.scope = 'col';
        row.append(element);
        return element;
    }
    function makeTable(caption, labels) {
        const element = node('table'); element.append(node('caption', caption));
        const head = node('thead'); const row = node('tr');
        labels.forEach(label => cell(row, label, {header: true})); head.append(row);
        const body = node('tbody'); element.append(head, body);
        return {element, body, columns: labels.length};
    }
    function emptyRow(table, text) {
        const row = node('tr');
        for (let column = 0; column < table.columns; column++) cell(row, column === 0 ? text : '');
        table.body.append(row);
    }
    function questionTable(questions) {
        const table = makeTable('Questions', ['Question', 'Result', 'Written hints', 'AI hints']);
        for (const question of questions) {
            const row = node('tr'); cell(row, `Question ${question.number}`);
            cell(row, question.solved === null ? 'Not checked' : question.solved ? 'Solved' : 'Not solved');
            cell(row, String(question.writtenHints));
            const levels = question.aiHints.levels.map(level => ({nudge: 'Nudge', point: 'Point', kind: 'Show the kind'})[level]);
            cell(row, `${question.aiHints.count}${levels.length ? ` (${levels.join(', ')})` : ''}`); table.body.append(row);
        }
        if (!questions.length) emptyRow(table, 'No question results saved.');
        return table.element;
    }
    function blockTable(blocks) {
        const table = makeTable('Blocks', ['Block', 'Who', 'Context']);
        for (const block of blocks) {
            const row = node('tr');
            const name = cell(row, `${blockName(block.type)}, ${block.number ? `block ${block.number} of stack ${block.stack}` : 'unplaced block'}`);
            if (block.kind === 'created') { name.append(mark(), node('span', ` made by ${assistantName()}`, 'visually-hidden')); }
            cell(row, block.kind === 'learner' ? 'Student' : 'AI'); cell(row, relianceContext(block)); table.body.append(row);
        }
        if (!blocks.length) emptyRow(table, 'No added or changed blocks.');
        return table.element;
    }
    function chart(percentages, label) {
        const svg = svgNode('svg', {viewBox: '0 0 600 90', role: 'img', 'aria-label': label, class: 'reliance-chart'});
        let x = 0;
        for (const {key} of RELIANCE_GROUPS) {
            const width = percentages[key] * 6;
            svg.append(svgNode('rect', {x, y: 0, width, height: 28, class: `reliance-${key}`})); x += width;
        }
        const text = svgNode('text', {x: 0, y: 60}); text.textContent = label; svg.append(text);
        const placeholder = svgNode('svg', {viewBox: '0 0 600 85', role: 'img',
            'aria-label': 'Hints and help over time. In progress.', class: 'reliance-chart reliance-placeholder'});
        for (const [line, y] of [['Hints and help over time', 30], ['In progress', 60]]) {
            const text = svgNode('text', {x: 16, y}); text.textContent = line; placeholder.append(text);
        }
        const charts = node('div', undefined, 'reliance-charts'); charts.hidden = !maximized; charts.append(svg, placeholder);
        return charts;
    }
    function setMax(value) {
        maximized = value; container.classList.toggle('reliance-max', value);
        size.setAttribute('aria-label', `${value ? 'Minimize' : 'Maximize'} AI Reliance`);
        size.textContent = value ? 'Minimize' : 'Maximize';
        const charts = panel.querySelector('.reliance-charts'); if (charts) charts.hidden = !value;
    }
    function render() {
        title.textContent = active ? 'AI Reliance' : 'Code';
        panel.hidden = !active; figures.hidden = !active || !submission; note.hidden = figures.hidden; size.hidden = !active;
        code.hidden = active; language.hidden = active;
        doc.querySelector('label[for="languageSelect"]').hidden = active;
        container.classList.toggle('reliance-active', active);
        panel.replaceChildren(); figures.replaceChildren();
        if (!active) { setMax(false); return; }
        if (!submission) { setMax(false); panel.append(node('p', 'Pick a submission to see how it was made.')); return; }
        const {blocks, percentages} = relianceData(submission.summary);
        const spoken = RELIANCE_GROUPS.map(({key, label}) => `${label} ${percentages[key]} percent`).join(', ');
        figures.setAttribute('role', 'group'); figures.setAttribute('aria-label', spoken);
        for (const {key, label} of RELIANCE_GROUPS) {
            const figure = node('span', `${label} ${percentages[key]}%`); figure.setAttribute('aria-hidden', 'true'); figures.append(figure);
        }
        panel.append(questionTable(submission.summary.questions || []), blockTable(blocks), chart(percentages, spoken));
    }
    const maximize = () => {setMax(!maximized); size.focus();};
    const escape = event => {
        if (event.key !== 'Escape' || !maximized) return;
        event.preventDefault(); event.stopPropagation(); setMax(false); size.focus();
    };
    size.addEventListener('click', maximize); container.addEventListener('keydown', escape);
    render();
    return {setActive(value) { active = value; render(); }, show(value) { submission = value; render(); },
        dispose() { setMax(false); size.removeEventListener('click', maximize); container.removeEventListener('keydown', escape); }};
}
