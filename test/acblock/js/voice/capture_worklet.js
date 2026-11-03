// Microphone capture: mono frames of 100 ms, posted to each attached engine worker through its own MessagePort.
class Capture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.targets = new Map();
        this.port.onmessage = ({ data }) => {
            if (data.port) {
                this.targets.set(data.id, {port: data.port, frame: new Float32Array(Math.round(sampleRate / 10)), filled: 0});
            }
            if (data.remove) this.targets.delete(data.remove);
        };
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel || !this.targets.size) return true;
        for (const target of this.targets.values()) {
            let i = 0;
            while (i < channel.length) {
                const n = Math.min(channel.length - i, target.frame.length - target.filled);
                target.frame.set(channel.subarray(i, i + n), target.filled);
                target.filled += n;
                i += n;
                if (target.filled === target.frame.length) {
                    target.port.postMessage({samples: target.frame.slice()});
                    target.filled = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('capture', Capture);
