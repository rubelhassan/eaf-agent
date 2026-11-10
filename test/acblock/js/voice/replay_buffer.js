// PCM for provisional speech stays in memory until it is replayed or dropped.
const SAMPLES_PER_MS = 16;
const CAPTURE_ID = 'server-replay';

/**
 * Shares capture with the recognizers; newId shares the server adapter's id counter.
 * @param {{attach: function(string, !Object): !Promise<*>, detach: function(string): void}} capture
 * @param {{maxUtteranceMs?: number, maxTotalMs?: number, newId?: function(): number,
 *     onDrop?: function(number, string): void, workerFactory?: function(): !Object}=} options
 */
export function createReplayBuffer(capture, {maxUtteranceMs = 60000, maxTotalMs = 180000,
    newId = (() => { let next = 0; return () => ++next; })(), onDrop = () => {},
    workerFactory = () => new Worker(new URL('./pcm_worker.js', import.meta.url), {type: 'module'})} = {}) {
    const buffers = new Map();
    let total = 0;
    let current = null;
    let enabled = false;
    let worker = null;
    let opening = null;
    let generation = 0;

    function detach() {
        generation++;
        capture.detach(CAPTURE_ID);
        worker?.postMessage({type: 'stop'});
        worker?.terminate(); worker = null;
    }
    function end(id) {
        const entry = buffers.get(id);
        if (entry) clearTimeout(entry.timer);
        if (current !== id) return;
        current = null; worker?.postMessage({type: 'end'});
        if (!enabled) detach();
    }
    function drop(id, reason = 'cleared') {
        const entry = buffers.get(id);
        if (!entry) return;
        end(id); total -= entry.samples; buffers.delete(id);
        onDrop(id, reason);
    }
    function audio({data}) {
        const entry = buffers.get(current);
        if (!entry || data.type !== 'frame') return;
        const room = maxUtteranceMs * SAMPLES_PER_MS - entry.samples;
        const pcm = data.pcm.slice(0, room);
        entry.frames.push({pcm, captureMs: data.captureMs - (data.pcm.length - pcm.length) / SAMPLES_PER_MS});
        entry.samples += pcm.length; total += pcm.length;
        if (entry.samples >= maxUtteranceMs * SAMPLES_PER_MS) end(current);
        while (total > maxTotalMs * SAMPLES_PER_MS) drop(buffers.keys().next().value, 'total');
    }
    async function setEnabled(on) {
        enabled = on;
        if (!enabled) { if (current === null) detach(); return; }
        if (worker || opening) return opening;
        const version = ++generation;
        let candidate;
        try { candidate = workerFactory(); } catch { clear(); return; }
        worker = candidate;
        candidate.onmessage = (event) => { if (version === generation && worker === candidate) audio(event); };
        const pending = capture.attach(CAPTURE_ID, candidate);
        opening = pending;
        try {
            await pending;
            if (version !== generation) { capture.detach(CAPTURE_ID); return; }
            if (current !== null) candidate.postMessage({type: 'begin'});
        } catch {
            clear();
        } finally {
            if (opening === pending) opening = null;
            if (enabled && !worker) void setEnabled(true);
        }
    }
    function clear() {
        enabled = false;
        detach();
        for (const id of [...buffers.keys()]) drop(id);
    }
    return {
        setEnabled, clear, drop, end,
        ids: () => [...buffers.keys()],
        begin() {
            if (!enabled) return null;
            if (current !== null) end(current);
            const id = newId();
            const timer = setTimeout(() => end(id), maxUtteranceMs);
            buffers.set(id, {frames: [], samples: 0, timer}); current = id;
            worker?.postMessage({type: 'begin'});
            return id;
        },
        take(id) {
            const entry = buffers.get(id);
            if (!entry) return null;
            end(id); buffers.delete(id); total -= entry.samples;
            return entry.frames;
        },
    };
}
