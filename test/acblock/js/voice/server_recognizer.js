// Recognizer adapter: transport and utterance lifetimes stay out of the conversation controller.
import {createReplayBuffer} from './replay_buffer.js';
const HANGOVER_MS = 300;
const READY_MS = 3000;
const MAX_BUFFERED = 64000;
const MAX_LIVE = 4;
const PING_MS = 60000;
const PONG_MS = 10000;
const SPEECH_WAIT_MS = 1500;
const UTTERANCE_MS = 60000;
const RETRY_MS = [250, 500, 1000, 2000, 4000];
const BACKGROUND_MS = 5000;
const BACKGROUND_SLOW_MS = 30000;
const REPLAY_FRAME_ROOM = 6400;
const REPLAY_WAIT_MS = 10;
const clock = () => performance.timeOrigin + performance.now();
const failure = (reason, details = {}) => Object.assign(new Error(reason), {reason, ...details});

/** capture is shared with VAD and the local barge-in listener; dependencies can be faked. */
export function createServerRecognizer({capture, url, sessionId, request = fetch, Socket = WebSocket,
    workerFactory = () => new Worker(new URL('./pcm_worker.js', import.meta.url), {type: 'module'}),
    now = clock, mark = (name) => performance.mark(name), random = Math.random}) {
    const origin = url.replace(/\/$/, '');
    let socket = null;
    let authenticated = false;
    let connecting = null;
    let requestController = null;
    let cancelHandshake = null;
    let worker = null;
    let callbacks = null;
    let enabled = false;
    let active = false;
    let paused = false;
    let version = 0;
    let next = 0;
    let wireNext = 0;
    let current = null;
    let hangover = null;
    let retryTimer = null;
    let pingTimer = null;
    let pongTimer = null;
    let vocabulary = [];
    const live = new Map();
    const wireIds = new Map();
    const limited = new Set();
    const captureBase = now();
    let lastMessageAt = now();
    let connection = null;
    let connectionReason = null;
    let fallbackAt = 0;
    let attempt = 0;
    let rejectedTokens = 0;
    const post = (type) => worker?.postMessage({type});
    const replayBuffer = createReplayBuffer(capture, {workerFactory, newId: () => ++next,
        onDrop: (id, reason) => callbacks?.onReplayDrop?.(id, reason)});
    let replaySending = null;
    let replayTimer = null;

    function report(nextConnection, error) {
        if (!enabled || (connection === nextConnection && connectionReason === error.reason)) return;
        connection = nextConnection; connectionReason = error.reason;
        void replayBuffer.setEnabled(connection !== 'connected').catch(() => console.warn('[voice] replay-unavailable'));
        callbacks?.onConnection?.({connection, reason: error.reason, closeCode: error.closeCode,
            closeReason: error.closeReason, attempt, sinceLastMessageMs: Math.max(0, now() - lastMessageAt)});
    }
    function clearKeepalive() {
        clearInterval(pingTimer); clearTimeout(pongTimer); pingTimer = null; pongTimer = null;
    }
    function retireSocket() {
        clearKeepalive(); authenticated = false;
        const old = socket; socket = null;
        old?.close();
    }
    function send(message) {
        if (!authenticated || socket?.readyState !== 1) return false;
        try { socket.send(JSON.stringify(message)); return true; }
        catch { lose(failure('closed')); return false; }
    }
    function settle(id) {
        const entry = live.get(id);
        clearTimeout(entry?.waitTimer);
        if (entry?.wireId) wireIds.delete(entry.wireId);
        live.delete(id); limited.delete(id);
        if (replaySending?.id === id) { replaySending = null; clearTimeout(replayTimer); replayTimer = null; }
        if (current !== id) return;
        clearTimeout(hangover); hangover = null;
        current = null; post('end');
    }
    function cancel(id) {
        const ids = id === undefined ? [...live.keys()] : live.has(id) ? [id] : [];
        for (const value of ids) {
            const entry = live.get(value);
            if (entry.wireId) send({type: 'cancel', utterance: entry.wireId});
            settle(value);
        }
    }
    function settleLost() {
        for (const id of [...live.keys()]) {
            const replay = live.get(id).replay;
            settle(id);
            callbacks?.onError?.(failure('connection-lost', {code: 'connection-lost'}), {utterance: id, ...(replay ? {replay: true} : {})});
        }
    }
    function stopCapture() {
        active = false;
        capture.detach('server-asr'); post('stop');
        worker?.terminate(); worker = null;
    }
    function fallback(error) {
        if (!enabled) return;
        const retryingError = Object.assign(failure(error.reason || 'closed'), error, {retrying: true});
        const already = connection === 'fallback';
        clearTimeout(retryTimer); retryTimer = null;
        requestController?.abort(); cancelHandshake?.();
        retireSocket();
        for (const id of [...live.keys()]) {
            const replay = live.get(id).replay;
            settle(id);
            if (replay) callbacks?.onReplayDrop?.(id, 'cleared');
        }
        stopCapture();
        report('fallback', retryingError);
        if (!already) {
            fallbackAt = now();
            callbacks?.onError?.(retryingError);
        }
        scheduleBackground();
        return retryingError;
    }
    function keepalive() {
        clearKeepalive();
        pingTimer = setInterval(() => {
            if (!enabled || !send({type: 'ping'})) return;
            pongTimer = setTimeout(() => lose(failure('pong-missing')), PONG_MS);
        }, PING_MS);
    }
    function retryLog(error) {
        console.info('[voice] retry', {from: 'server', to: 'server', connection, reason: error.reason,
            closeCode: error.closeCode ?? null, closeReason: error.closeReason || '', attempt,
            sinceLastMessageMs: Math.max(0, now() - lastMessageAt)});
    }
    function recovered() {
        if (!authenticated || socket?.readyState !== 1) throw failure('closed');
        clearTimeout(retryTimer); retryTimer = null;
        report('connected', failure('recovered'));
        flushBuffered();
    }
    function scheduleBackground() {
        if (!enabled || !callbacks) return;
        clearTimeout(retryTimer);
        const generation = version;
        const delay = now() - fallbackAt < PING_MS ? BACKGROUND_MS : BACKGROUND_SLOW_MS;
        retryTimer = setTimeout(async () => {
            if (!enabled || generation !== version) return;
            retryTimer = null; attempt++;
            retryLog(failure(connectionReason));
            try { await open(); if (enabled && generation === version) recovered(); }
            catch { if (enabled && generation === version) scheduleBackground(); }
        }, delay);
    }
    function scheduleQuick(error) {
        if (!enabled) return;
        if (attempt >= RETRY_MS.length) { fallback(error); return; }
        const delay = RETRY_MS[attempt++] * (0.8 + random() * 0.4);
        const generation = version;
        retryTimer = setTimeout(async () => {
            if (!enabled || generation !== version) return;
            retryTimer = null; retryLog(error);
            try { await open(); if (enabled && generation === version) recovered(); }
            catch (nextError) {
                if (!enabled || generation !== version || connection !== 'reconnecting') return;
                if (nextError.unavailable) fallback(nextError);
                else scheduleQuick(nextError);
            }
        }, delay);
    }
    function lose(error) {
        if (!enabled || connection === 'reconnecting') return;
        retireSocket(); settleLost();
        if (connection === 'fallback' || error.unavailable) { fallback(error); return; }
        attempt = 0;
        report('reconnecting', error);
        scheduleQuick(error);
    }
    function result(message) {
        if (message.type === 'pong') { clearTimeout(pongTimer); pongTimer = null; return; }
        const id = wireIds.get(message.utterance);
        const replay = live.get(id)?.replay;
        if (!active || (paused && !replay)) return;
        if (message.type === 'error' && ['engine-failed', 'manifest-mismatch'].includes(message.code)) {
            fallback(failure(message.code, {code: message.code, unavailable: true})); return;
        }
        if (!live.has(id)) return;
        if (message.type === 'error') {
            const error = Object.assign(new Error(message.code), {code: message.code});
            if (message.code === 'too-long') {
                if (current === id) {
                    clearTimeout(hangover); hangover = null;
                    current = null; post('end');
                }
                limited.add(id);
            } else settle(id);
            callbacks?.onError?.(error, {utterance: id, ...(replay ? {replay: true} : {})});
            return;
        }
        if (message.type !== 'final' || typeof message.text !== 'string' || !Number.isInteger(message.revision) || message.revision < 1) return;
        const limitNotice = limited.has(id);
        settle(id);
        mark('voice:final-received', {utterance: id});
        const handlers = callbacks;
        handlers?.onFinal?.(message.text, {utterance: id, ...(replay ? {replay: true} : {})});
        if (limitNotice && !replay) handlers?.onLimit?.();
    }
    async function fetchStatus(path, options = {}) {
        requestController = new AbortController();
        const controller = requestController;
        const timer = setTimeout(() => controller.abort(), READY_MS);
        try { return await request(origin + path, {...options, signal: controller.signal}); }
        catch { throw failure(controller.signal.aborted ? 'health-timeout' : 'closed'); }
        finally { clearTimeout(timer); if (requestController === controller) requestController = null; }
    }
    async function connect() {
        const generation = version;
        const health = await fetchStatus('/v1/health');
        if (!enabled || generation !== version) throw failure('voice-cancelled');
        if (!health.ok || (await health.json()).voice?.status !== 'ready') throw failure('voice-unavailable', {unavailable: true});
        if (authenticated && socket?.readyState === 1) { keepalive(); return; }
        const response = await fetchStatus('/v1/voice/session', {method: 'POST'});
        if (!enabled || generation !== version) throw failure('voice-cancelled');
        if (!response.ok) throw failure(response.status === 401 ? 'token-rejected' : 'voice-unavailable', {unavailable: response.status === 503});
        const {token} = await response.json();
        if (!enabled || generation !== version) throw failure('voice-cancelled');
        const candidate = new Socket(origin.replace(/^http/, 'ws') + '/v1/voice/stream');
        socket = candidate;
        await new Promise((resolve, reject) => {
            let welcomed = false;
            const timer = setTimeout(() => fail(failure('health-timeout')), READY_MS);
            const fail = (error) => {
                clearTimeout(timer);
                if (socket !== candidate) return;
                cancelHandshake = null;
                socket = null; authenticated = false; clearKeepalive(); candidate.close();
                if (!welcomed) reject(error);
                else if (enabled) lose(error);
            };
            cancelHandshake = () => fail(failure('voice-cancelled'));
            candidate.onopen = () => {
                if (!enabled || generation !== version) { fail(failure('voice-cancelled')); return; }
                // Buffered frames keep the same clock when a new socket opens.
                try { candidate.send(JSON.stringify({type: 'hello', token, sessionId, captureMs: now() - captureBase})); }
                catch { fail(failure('closed')); }
            };
            candidate.onmessage = ({data}) => {
                if (socket !== candidate || !enabled) return;
                lastMessageAt = now();
                let message;
                try { message = JSON.parse(data); if (!message || typeof message !== 'object') throw failure('closed'); }
                catch { fail(failure('closed')); return; }
                if (!welcomed && message.type === 'ready') {
                    clearTimeout(timer); welcomed = true; authenticated = true; wireNext = 0; rejectedTokens = 0;
                    cancelHandshake = null;
                    keepalive(); resolve();
                } else if (!welcomed && message.type === 'error') {
                    fail(failure(message.code === 'manifest-mismatch' ? 'voice-unavailable' : 'engine-failed', {unavailable: true}));
                } else if (welcomed) result(message);
            };
            candidate.onerror = () => fail(failure('closed'));
            candidate.onclose = (event = {}) => {
                const code = event.code;
                if (code === 4401) rejectedTokens++;
                const reason = code === 4408 ? 'idle-closed' : code === 4401 ? 'token-rejected' : 'closed';
                const known = ['idle', 'overloaded', 'bad-token', 'hello-required', 'bad-frame', 'audio-without-utterance'];
                fail(failure(reason, {closeCode: code, closeReason: known.includes(event.reason) ? event.reason : '',
                    unavailable: code === 4401 && rejectedTokens >= 2}));
            };
        });
    }
    function open() {
        if (!connecting) {
            const pending = connect().catch((error) => { throw error.reason ? error : failure('closed'); });
            connecting = pending;
            pending.finally(() => { if (connecting === pending) connecting = null; }).catch(() => {});
        }
        return connecting;
    }
    async function ready(handlers) {
        if (handlers) callbacks = {...callbacks, ...handlers};
        enabled = true;
        globalThis.addEventListener?.('pagehide', disconnect);
        const generation = version;
        try {
            await open();
            if (!enabled || generation !== version) throw failure('voice-cancelled');
            report('connected', failure(connection === 'connected' ? connectionReason : connection === 'fallback' ? 'recovered' : 'session-start'));
        } catch (error) {
            if (enabled && generation === version) throw fallback(error);
            throw error;
        }
    }
    function sendFrame(entry, data) {
        if (!authenticated || socket?.readyState !== 1 || socket.bufferedAmount > MAX_BUFFERED) {
            lose(failure('backpressure')); return;
        }
        const frame = new ArrayBuffer(12 + data.pcm.byteLength);
        const header = new DataView(frame);
        header.setUint32(0, entry.wireId, true); header.setUint32(4, entry.sequence++, true);
        header.setUint32(8, Math.max(0, Math.round(data.captureMs - captureBase)), true);
        new Int16Array(frame, 12).set(data.pcm);
        if (entry.sequence === 1) mark('voice:first-frame');
        try { socket.send(frame); } catch { lose(failure('closed')); }
    }
    function attachUtterance(id) {
        const entry = live.get(id);
        if (!entry) return;
        entry.wireId = ++wireNext;
        wireIds.set(entry.wireId, id);
        send({type: 'utterance', utterance: entry.wireId, vocabulary: entry.vocabulary, ...(entry.replay ? {replay: true} : {})});
    }
    function flushBuffered() {
        for (const [id, entry] of live) {
            if (entry.wireId || connection !== 'connected') continue;
            clearTimeout(entry.waitTimer);
            attachUtterance(id);
            for (const frame of entry.frames) { if (!live.has(id)) break; sendFrame(entry, frame); }
            entry.frames = [];
            if (entry.ended && live.has(id)) {
                send({type: 'end', utterance: entry.wireId, speechEndMs: Math.max(0, entry.endAt - captureBase)});
                settleCapture(id);
            }
        }
    }
    function audio({data}) {
        if (!active || paused || current === null || data.type !== 'frame') return;
        const entry = live.get(current);
        if (!entry) return;
        if (!entry.wireId) {
            entry.samples += data.pcm.length;
            if (entry.samples > UTTERANCE_MS * 16) { fallback(failure('buffer-full')); return; }
            entry.frames.push({pcm: data.pcm.slice(), captureMs: data.captureMs});
        } else sendFrame(entry, data);
    }
    function settleCapture(id) {
        if (current === id) { current = null; post('end'); }
    }
    function sendReplay() {
        replayTimer = null;
        const sending = replaySending;
        if (!sending || !enabled || !live.has(sending.id)) return;
        const entry = live.get(sending.id);
        while (sending.index < sending.frames.length) {
            if (current !== null || socket?.bufferedAmount > MAX_BUFFERED - REPLAY_FRAME_ROOM) {
                replayTimer = setTimeout(sendReplay, REPLAY_WAIT_MS); return;
            }
            sendFrame(entry, sending.frames[sending.index++]);
            if (!live.has(sending.id)) return;
        }
        const last = sending.frames.at(-1);
        send({type: 'end', utterance: entry.wireId, speechEndMs: Math.max(0, last.captureMs - captureBase)});
        replaySending = null;
    }
    function stop() {
        ++version; enabled = false;
        clearTimeout(retryTimer); clearTimeout(hangover);
        retryTimer = null; hangover = null;
        clearKeepalive(); requestController?.abort(); cancelHandshake?.(); connecting = null;
        clearTimeout(replayTimer); replayTimer = null; replaySending = null;
        replayBuffer.clear();
        for (const [id, entry] of [...live]) if (entry.replay) callbacks?.onReplayDrop?.(id, 'cleared');
        cancel(); callbacks = null; stopCapture();
        connection = null; connectionReason = null;
    }
    function disconnect() {
        globalThis.removeEventListener?.('pagehide', disconnect);
        stop(); retireSocket();
    }
    return {
        cased: true, endpointing: 'vad', ready, replayBuffer,
        replay(id, frames) {
            if (!active || connection !== 'connected' || current !== null || replaySending || live.size >= MAX_LIVE || !frames?.length || live.has(id)) return false;
            live.set(id, {replay: true, wireId: null, sequence: 0, vocabulary: [...vocabulary]});
            attachUtterance(id);
            if (!live.has(id) || connection !== 'connected') return false;
            replaySending = {id, frames, index: 0}; sendReplay();
            return true;
        },
        async start(handlers) {
            callbacks = handlers;
            const generation = version;
            await ready();
            if (generation !== version || !enabled) return;
            active = true; paused = false;
            worker = workerFactory(); worker.onmessage = audio;
            await capture.attach('server-asr', worker);
            if (generation !== version) { capture.detach('server-asr'); worker?.terminate(); }
        },
        speechStart() {
            if (!active || paused || connection === 'fallback') return null;
            if (hangover) {
                clearTimeout(hangover); hangover = null;
                clearTimeout(live.get(current)?.waitTimer);
                return current;
            }
            if (current !== null) return current;
            if (live.size >= MAX_LIVE) {
                const oldest = live.keys().next().value;
                cancel(oldest);
                callbacks?.onError?.(Object.assign(new Error('overloaded'), {code: 'overloaded'}), {utterance: oldest});
            }
            current = ++next;
            live.set(current, {wireId: null, sequence: 0, vocabulary: [...vocabulary], frames: [], samples: 0, ended: false});
            if (connection === 'connected') attachUtterance(current);
            post('begin');
            return current;
        },
        speechEnd() {
            if (!active || paused || current === null) return null;
            const id = current;
            const entry = live.get(id);
            entry.endAt = now();
            if (entry.wireId) send({type: 'pause', utterance: entry.wireId, captureMs: Math.max(0, entry.endAt - captureBase)});
            else {
                clearTimeout(entry.waitTimer);
                entry.waitTimer = setTimeout(() => fallback(failure(connectionReason)), SPEECH_WAIT_MS);
            }
            clearTimeout(hangover);
            hangover = setTimeout(() => {
                hangover = null;
                if (!active || current !== id || !live.has(id)) return;
                entry.ended = true;
                if (entry.wireId) send({type: 'end', utterance: entry.wireId, speechEndMs: Math.max(0, entry.endAt - captureBase)});
                mark('voice:end-sent', {utterance: id}); settleCapture(id);
            }, HANGOVER_MS);
            return id;
        },
        setVocabulary: (words) => { vocabulary = [...words]; },
        setHotwords() {}, cancel,
        pause() { paused = true; for (const [id, entry] of live) if (!entry.replay) cancel(id); post('pause'); },
        resume() { paused = false; post('resume'); },
        stop, disconnect,
    };
}
