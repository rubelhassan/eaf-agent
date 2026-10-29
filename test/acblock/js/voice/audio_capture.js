/**
 * One microphone for every voice engine: opened when the first engine attaches, closed when the last one leaves.
 * Frames go from the AudioWorklet straight to each engine's worker.
 */
export function createAudioCapture() {
    let audio = null;
    let opening = null;
    const attached = new Set();

    async function open() {
        if (audio) return audio;
        opening = opening || (async () => {
            const media = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            const context = new AudioContext();
            await context.audioWorklet.addModule(new URL('./capture_worklet.js', import.meta.url));
            const node = new AudioWorkletNode(context, 'capture');
            // A silent path to the speakers keeps the capture node running.
            const mute = context.createGain();
            mute.gain.value = 0;
            context.createMediaStreamSource(media).connect(node).connect(mute).connect(context.destination);
            audio = { media, context, node };
            return audio;
        })();
        try {
            return await opening;
        } finally {
            opening = null;
        }
    }

    function close() {
        if (!audio) return;
        audio.media.getTracks().forEach((t) => t.stop());
        audio.context.close();
        audio = null;
    }

    return {
        /** Sends frames to the worker as a 'start' message with {sampleRate, port}. */
        async attach(id, worker) {
            const { context, node } = await open();
            const channel = new MessageChannel();
            node.port.postMessage({ id, port: channel.port1 }, [channel.port1]);
            worker.postMessage({ type: 'start', sampleRate: context.sampleRate, port: channel.port2 }, [channel.port2]);
            attached.add(id);
        },
        detach(id) {
            if (!attached.delete(id)) return;
            audio?.node.port.postMessage({ remove: id });
            if (!attached.size) close();
        },
    };
}
