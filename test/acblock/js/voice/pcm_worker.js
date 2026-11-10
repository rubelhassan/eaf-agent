// Windowed sinc filtering keeps high frequencies from aliasing during fractional resampling.
const OUTPUT_RATE = 16000;
const FRAME_SAMPLES = 1600;
const RADIUS = 24;

/** A streaming mono resampler; push keeps filter history between capture frames. */
export function createPcmResampler(sampleRate) {
    if (!Number.isFinite(sampleRate) || sampleRate < OUTPUT_RATE || sampleRate > 192000) throw new Error('sample-rate');
    const step = sampleRate / OUTPUT_RATE;
    const cutoff = Math.min(1, OUTPUT_RATE / sampleRate) * 0.9;
    let samples = Array(RADIUS).fill(0);
    let position = RADIUS;
    return {
        push(input) {
            for (const sample of input) samples.push(sample);
            const output = [];
            while (position + RADIUS < samples.length) {
                const center = Math.floor(position);
                let total = 0;
                let weight = 0;
                for (let index = center - RADIUS + 1; index <= center + RADIUS; index++) {
                    const distance = index - position;
                    const phase = Math.PI * distance * cutoff;
                    const sinc = phase === 0 ? cutoff : Math.sin(phase) / (Math.PI * distance);
                    const window = 0.5 * (1 + Math.cos(Math.PI * distance / RADIUS));
                    const coefficient = sinc * window;
                    total += samples[index] * coefficient;
                    weight += coefficient;
                }
                const value = Math.max(-1, Math.min(1, total / weight));
                output.push(Math.round(value * (value < 0 ? 32768 : 32767)));
                position += step;
            }
            const consumed = Math.floor(position) - RADIUS;
            if (consumed > 0) { samples = samples.slice(consumed); position -= consumed; }
            return Int16Array.from(output);
        },
    };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    let port = null;
    let resampler = null;
    let pending = [];
    let ring = [];
    let active = false;
    let paused = false;
    let samples = 0;
    let baseMs = 0;
    function audio(input) {
        const converted = resampler.push(input);
        for (const value of converted) pending.push(value);
        while (pending.length >= FRAME_SAMPLES) {
            const pcm = Int16Array.from(pending.splice(0, FRAME_SAMPLES));
            samples += pcm.length;
            const frame = {type: 'frame', captureMs: baseMs + samples / 16, pcm};
            if (!paused) {
                ring.push(frame);
                if (ring.length > 5) ring.shift();
                if (active) self.postMessage(frame);
            }
        }
    }
    self.onmessage = ({data}) => {
        if (data.type === 'start') {
            port?.close();
            port = data.port;
            resampler = createPcmResampler(data.sampleRate);
            baseMs = performance.timeOrigin + performance.now();
            samples = 0; pending = []; ring = []; active = false; paused = false;
            port.onmessage = ({data: frame}) => audio(frame.samples);
        } else if (data.type === 'begin') {
            if (paused || active) return;
            active = true;
            ring.forEach((frame) => self.postMessage(frame));
        } else if (data.type === 'end') active = false;
        else if (data.type === 'pause') { active = false; paused = true; ring = []; }
        else if (data.type === 'resume') paused = false;
        else if (data.type === 'stop') {
            port?.close(); port = null; active = false; paused = true; ring = []; pending = [];
        }
    };
}
