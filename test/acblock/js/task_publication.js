const TASK_READ_TIMEOUT_MS = 2000;
const TASK_WRITE_TIMEOUT_MS = 10000;

/** Teacher publishing stays in the host; events contain codes, never task XML. @param {!Object} options */
function createTaskPublication({workspace, document: doc, entry, serverUrl, snapshot, cleanXml, loadXml,
    bundledXml, validateXml, getPolicy, onPolicyChange, ModalForm, say, record, fetch: send = (...args) => fetch(...args)}) {
    const bar = doc.getElementById('taskPublication');
    const status = doc.getElementById('publicationState');
    const buttons = ['publishTaskBtn', 'discardTaskBtn', 'resetTaskBtn'].map(id => doc.getElementById(id));
    const lifetime = new AbortController();
    let baseline = snapshot();
    let dirty = false;
    let loading = false;
    let pending = false;
    let disposed = false;
    let dialog = null;
    let revision = 0;

    function render() {
        bar.hidden = !getPolicy(workspace).teacherMode || !entry()?.serverTask;
        bar.parentElement.classList.toggle('with-publication', !bar.hidden);
        buttons.forEach(button => { button.disabled = pending || loading; });
        const text = dirty && !bar.hidden ? 'Not published' : '';
        if (status.textContent !== text) status.textContent = text;
    }

    function changed(event) {
        if (event?.isUiEvent || loading || disposed || dirty || !getPolicy(workspace).teacherMode || !entry()?.serverTask) return;
        if (snapshot() !== baseline) { dirty = true; render(); }
    }

    function failure(code) {
        const error = new Error(code === 'unreachable' ? "The server isn't reachable." : code === 404 ?
            'The server has no task storage (update and restart the agent server).' : `The server refused the task (code ${code}).`);
        error.code = code;
        return error;
    }

    async function request({taskId, method = 'GET', body}) {
        const url = serverUrl();
        if (!url) throw failure('unreachable');
        let response;
        try {
            response = await send(`${url}/v1/tasks${method === 'POST' ? '' : '/' + encodeURIComponent(taskId)}${method === 'GET' ? '/latest' : ''}`, {
                method, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(
                    method === 'GET' ? TASK_READ_TIMEOUT_MS : TASK_WRITE_TIMEOUT_MS)]),
                ...(body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {}),
            });
        } catch (error) { throw failure('unreachable'); }
        const result = await response.json().catch(() => null);
        if (method === 'GET' && response.status === 404 && result?.error === 'task not found') return {code: 404, result: null};
        if (!response.ok) throw failure(response.status);
        return {code: response.status, result};
    }

    const current = (taskId, version) => !disposed && entry()?.id === taskId && revision === version;
    function outcome(kind, {taskId, code, text}) {
        record(kind, {taskId, code});
        if (text) say(text);
    }

    async function publish() {
        const task = entry();
        if (!task?.serverTask || !getPolicy(workspace).teacherMode || pending || loading) return;
        const version = revision;
        const before = snapshot();
        pending = true; render();
        try {
            const response = await request({taskId: task.id, method: 'POST', body: {taskId: task.id, title: task.label,
                savedAt: new Date().toISOString(), taskXml: cleanXml()}});
            if (typeof response.result?.versionId !== 'string') throw failure(response.code);
            if (!current(task.id, version)) { outcome('task.published', {taskId: task.id, code: response.code}); return; }
            baseline = before; dirty = snapshot() !== before;
            outcome('task.published', {taskId: task.id, code: response.code, text: 'Published. Students get this version from now on.'});
        } catch (error) {
            if (!disposed) outcome('task.published', {taskId: task.id, code: error.code ?? 'failed', text: error.message});
        } finally { pending = false; if (!disposed) render(); }
    }

    async function discard() {
        const task = entry();
        if (!task?.serverTask || !getPolicy(workspace).teacherMode || pending || loading) return;
        const version = revision;
        pending = true; render();
        try {
            const response = await request({taskId: task.id});
            const xml = response.result ? response.result.taskXml : await bundledXml(task);
            if (response.result && (response.result.taskId !== task.id || typeof xml !== 'string')) throw failure(response.code);
            if (!validateXml(xml)) throw failure(response.code);
            if (!current(task.id, version)) { outcome('task.discarded', {taskId: task.id, code: response.code}); return; }
            loadXml(xml); workspace.clearUndo(); loaded();
            outcome('task.discarded', {taskId: task.id, code: response.code, text: response.result ?
                'Discarded your changes. Loaded the published version.' : 'Discarded your changes. Loaded the original task.'});
        } catch (error) {
            if (!disposed) outcome('task.discarded', {taskId: task.id, code: error.code ?? 'failed', text: error.message});
        } finally { pending = false; if (!disposed) render(); }
    }

    function confirmReset() {
        return new Promise(resolve => {
            let settled = false;
            const finish = value => { if (!settled) { settled = true; resolve(value); } };
            class ResetForm extends ModalForm {
                close_() { const opened = this.isOpen(); super.close_(); if (opened) finish(false); }
            }
            dialog = new ResetForm();
            const cancel = dialog.button_('Cancel', () => dialog.close_());
            const reset = dialog.button_('Reset', () => { finish(true); dialog.close_(); }, true);
            dialog.openShell_('Reset Demo: Question Blocks?', [dialog.help_(
                'This removes every published version. Teachers and students get the original task again.')], [reset, cancel]);
            cancel.focus();
        });
    }

    async function reset() {
        const task = entry();
        if (!task?.serverTask || !getPolicy(workspace).teacherMode || pending || loading) return;
        const version = revision;
        if (!await confirmReset()) { if (!disposed) outcome('task.reset', {taskId: task.id, code: 'cancelled'}); return; }
        if (!current(task.id, version)) return;
        pending = true; render();
        try {
            const response = await request({taskId: task.id, method: 'DELETE'});
            if (!Number.isInteger(response.result?.removed) || response.result.removed < 0) throw failure(response.code);
            const xml = await bundledXml(task);
            if (!current(task.id, version)) { outcome('task.reset', {taskId: task.id, code: response.code}); return; }
            loadXml(xml); workspace.clearUndo(); loaded();
            outcome('task.reset', {taskId: task.id, code: response.code, text: 'Reset. Everyone gets the original Demo: Question Blocks.'});
        } catch (error) {
            if (!disposed) outcome('task.reset', {taskId: task.id, code: error.code ?? 'failed', text: error.message});
        } finally {
            pending = false;
            if (!disposed) { render(); if (!bar.hidden && entry()?.id === task.id) buttons[2].focus(); }
        }
    }

    function loaded() { revision++; loading = false; baseline = snapshot(); dirty = false; render(); }
    const handlers = [publish, discard, reset];
    buttons.forEach((button, i) => button.addEventListener('click', handlers[i]));
    workspace.addChangeListener(changed);
    const offPolicy = onPolicyChange(workspace, () => { changed(); render(); });
    doc.addEventListener('eaf-task-server', render);
    render();
    return {publish, discard, reset, loaded, render, changed,
        beginLoad() { revision++; loading = true; render(); },
        dispose() {
            disposed = true; lifetime.abort(); dialog?.close_();
            workspace.removeChangeListener(changed); offPolicy(); doc.removeEventListener('eaf-task-server', render);
            buttons.forEach((button, i) => button.removeEventListener('click', handlers[i]));
        },
    };
}
