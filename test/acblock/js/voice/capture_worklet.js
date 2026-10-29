// Microphone capture: mono frames of about 100 ms, posted to each attached engine worker through its own MessagePort.
class Capture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.targets = new Map();
        this.frame = new Float32Array(Math.round(sampleRate / 10));
        this.filled = 0;
        this.port.onmessage = ({ data }) => {
            if (data.port) this.targets.set(data.id, data.port);
            if (data.remove) this.targets.delete(data.remove);
        };
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel || !this.targets.size) return true;
        let i = 0;
        while (i < channel.length) {
            const n = Math.min(channel.length - i, this.frame.length - this.filled);
            this.frame.set(channel.subarray(i, i + n), this.filled);
            this.filled += n;
            i += n;
            if (this.filled === this.frame.length) {
                for (const port of this.targets.values()) port.postMessage({ samples: this.frame.slice() });
                this.filled = 0;
            }
        }
        return true;
    }
}

registerProcessor('capture', Capture);
