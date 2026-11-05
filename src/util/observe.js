// @ts-check
/**
 * Change listeners on plain object properties (e.g. the cursor's editMode), for
 * state that has no events. Several listeners can watch the same property.
 */

/** @type {!WeakMap<!Object, !Map<string, !Set<function(): void>>>} */
const watched = new WeakMap();

/**
 * @param {!Object} target
 * @param {string} key
 * @param {function(): void} onChange  Called after the value changes.
 * @returns {function(): void} Stops listening; the last one restores the plain property.
 */
export function observeProperty(target, key, onChange) {
  if (!watched.has(target)) watched.set(target, new Map());
  const keys = watched.get(target);
  if (!keys.has(key)) {
    const listeners = new Set();
    keys.set(key, listeners);
    let value = target[key];
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next) => {
        if (next === value) return;
        value = next;
        [...listeners].forEach((fn) => fn());
      },
    });
  }
  const listeners = keys.get(key);
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
    if (listeners.size) return;
    const value = target[key];
    delete target[key];
    target[key] = value;
    keys.delete(key);
  };
}
