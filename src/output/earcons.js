// @ts-check
// Short tones made with Web Audio, no files. Each earcon is a list of tones; its length is known up front.

/** @typedef {{hz: number, toHz?: number, ms: number, wave?: OscillatorType, gap?: number, level?: number, attack?: number}} Tone */

/** @type {!Readonly<Record<string, !Array<Tone>>>} */
export const EARCONS = Object.freeze({
  solved: [{hz: 523, ms: 60, gap: 15, level: 0.45, attack: 15},
    {hz: 659, ms: 60, gap: 15, level: 0.45, attack: 15}, {hz: 784, ms: 140, level: 0.45, attack: 15}],
  aiTurn: [{hz: 660, ms: 50, gap: 20}, {hz: 880, ms: 60}],
  sent: [{hz: 1400, ms: 40, wave: 'triangle', level: 0.6}],
  listeningOn: [{hz: 440, toHz: 880, ms: 120}],
  listeningOff: [{hz: 880, toHz: 440, ms: 120}],
  // Every few quiet seconds while listening: the listening-on tone, quieter and with a slow start.
  listeningReminder: [{hz: 440, toHz: 880, ms: 120, level: 0.48, attack: 40}],
  // Switched to the basic speech engine: two flat, soft tones, unlike the rising listening tones.
  engineBasic: [{hz: 587, ms: 80, wave: 'triangle', gap: 40, level: 0.7}, {hz: 587, ms: 80, wave: 'triangle', level: 0.7}],
  blocked: [{hz: 150, ms: 100, wave: 'square', level: 0.4}],
  error: [{hz: 520, ms: 60, gap: 20}, {hz: 390, ms: 70}],
  connected: [{hz: 1046, ms: 70}],
  rejected: [{hz: 220, ms: 50, wave: 'triangle', gap: 30}, {hz: 220, ms: 50, wave: 'triangle'}],
  enteredStack: [{hz: 500, toHz: 700, ms: 70}],
  leftStack: [{hz: 700, toHz: 500, ms: 70}],
});

export const VOLUMES = Object.freeze({low: 0.15, medium: 0.3, high: 0.5});

/** @returns {number} milliseconds */
export function earconLength(name) {
  return (EARCONS[name] || []).reduce((ms, t) => ms + t.ms + (t.gap || 0), 0);
}

/**
 * Plays earcons through one AudioContext, made on first use (browsers allow it after a key press or click).
 * @param {{createContext?: function(): ?AudioContext}=} options
 * @returns {{play(name: string, options?: {signal?: AbortSignal}): !Promise<void>, setVolume(volume: string): void, dispose(): void}}
 */
export function createEarconPlayer({createContext = () => (typeof AudioContext === 'function' ? new AudioContext() : null)} = {}) {
  let context = null;
  let level = VOLUMES.medium;

  return {
    play(name, {signal} = {}) {
      const tones = EARCONS[name];
      if (!tones || signal?.aborted) return Promise.resolve();
      context = context || createContext();
      if (!context) return Promise.resolve();
      if (context.state === 'suspended') context.resume();
      const nodes = [];
      let at = context.currentTime + 0.01;
      for (const tone of tones) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        const end = at + tone.ms / 1000;
        osc.type = tone.wave || 'sine';
        osc.frequency.setValueAtTime(tone.hz, at);
        if (tone.toHz) osc.frequency.linearRampToValueAtTime(tone.toHz, end);
        // Short attack (unless a tone asks for a slower one) and release, so tones don't click.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(level * (tone.level ?? 1), at + (tone.attack ?? 5) / 1000);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(gain).connect(context.destination);
        osc.start(at);
        osc.stop(end);
        nodes.push(osc);
        at = end + (tone.gap || 0) / 1000;
      }
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, earconLength(name) + 10);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          // stop() throws on a node that already stopped.
          nodes.forEach((n) => {
            try {
              n.stop();
            } catch (e) {}
          });
          resolve();
        }, {once: true});
      });
    },
    setVolume(volume) {
      level = VOLUMES[volume] ?? VOLUMES.medium;
    },
    dispose() {
      context?.close();
      context = null;
    },
  };
}
