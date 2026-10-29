// @ts-check
// Keys for the assistant: Alt+Shift+Y yes, A all, N stop, U undo, R repeat; Escape stops a working task; a Ctrl tap
// stops the AI voice; Ctrl+Shift+I stops it and listens. Alt+letter alone is the stack jump, so the answer keys
// keep Shift. Keys are read by e.code: Alt changes e.key on a Mac.

export const ANSWER_KEYS = Object.freeze({KeyY: 'yes', KeyA: 'all', KeyN: 'stop', KeyU: 'undo', KeyR: 'repeat'});

const UNAVAILABLE = {
  yes: 'There is nothing to say yes to.',
  all: 'There are no steps to do all at once.',
  stop: 'There is nothing to stop.',
  undo: 'There is nothing to undo.',
  repeat: 'There is nothing to repeat yet.',
};

/**
 * @param {{available: function(): !Array<string>, run: function(string): void, cancel: function(): boolean,
 *     say: function(string): void, interrupt?: function(): void, talk?: function(): void}} options
 *     run: carry out an available command; cancel: stop a working task (false when nothing was working);
 *     say: a short line when a command isn't available now;
 *     interrupt: stop the AI voice (Ctrl tap); talk: stop it and listen (Ctrl+Shift+I, also from the text box)
 * @returns {function(): void} stops listening
 */
export function bindAssistantKeys({available, run, cancel, say, interrupt = () => {}, talk = () => {}}) {
  // A Ctrl tap: Control pressed and released with no other key in between (so Ctrl+C doesn't count).
  let ctrlAlone = false;
  const onKeyUp = (e) => {
    if (e.key === 'Control' && ctrlAlone) interrupt();
    ctrlAlone = false;
  };
  const onKeyDown = (e) => {
    ctrlAlone = e.key === 'Control' && !e.shiftKey && !e.altKey && !e.metaKey;
    if (e.code === 'KeyI' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      talk();
      return;
    }
    if (e.key === 'Escape') {
      // Only while a task works; otherwise Escape keeps its usual meaning.
      if (cancel()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    const command = e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey ? ANSWER_KEYS[e.code] : null;
    if (!command) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (available().includes(command)) run(command);
    else say(UNAVAILABLE[command]);
  };
  // Capture phase, ahead of the editor's shortcuts and the navigation lock.
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
  };
}
