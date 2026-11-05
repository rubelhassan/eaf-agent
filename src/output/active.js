// @ts-check
// The output manager the plugin speaks through, set by the host app. None: Speech writes #blockReader directly.

let manager = null;

/** @param {?Object} next  from createOutputManager, or null */
export function setOutputManager(next) {
  manager = next;
}

export function getOutputManager() {
  return manager;
}

/** True when navigation speech uses the system voice instead of the learner's screen reader. */
export function systemVoiceOn() {
  return manager?.settings().systemOutput === 'systemVoice';
}
