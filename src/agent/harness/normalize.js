// @ts-check
// Turns unambiguous variants of the op shape into the real one, so a right answer isn't lost to its wording.

const PLACE_KEYS = ['after', 'before', 'parent', 'input'];
const PLACE_TEXT = /^\s*(after|before)\s*[:=\s]\s*"?([\w-]+)"?\s*$/i;

/** {place: {before: X}} or {place: "before:X"} -> {before: X}. */
function unwrapPlace(op, adjusted) {
  if (!('place' in op) || ['after', 'before', 'parent'].some((k) => k in op)) return;
  const place = op.place;
  if (place && typeof place === 'object') {
    for (const key of PLACE_KEYS) if (key in place) op[key] = place[key];
  } else if (typeof place === 'string' && PLACE_TEXT.test(place)) {
    const [, key, id] = place.match(PLACE_TEXT);
    op[key.toLowerCase()] = id;
  } else {
    return;
  }
  delete op.place;
  adjusted.add('place wrapper');
}

/** The block an op puts somewhere: a new block's id or a moved block's id. */
const placedId = (op) => (op.op === 'insert' ? op.block?.id : op.op === 'move' ? op.block : undefined);

/**
 * Drops an id written in a new block's inputs or next when a later op puts that very block there,
 * e.g. {"inputs":{"VALUE":"n2"}} followed by inserting n2 into VALUE of this block.
 */
function dropForwardRefs(ops, adjusted) {
  ops.forEach((op, k) => {
    if (op.op !== 'insert') return;
    const later = ops.slice(k + 1);
    const visit = (spec) => {
      if (!spec || typeof spec !== 'object') return;
      for (const [name, child] of Object.entries(spec.inputs || {})) {
        if (typeof child === 'string' && spec.id &&
            later.some((o) => placedId(o) === child && o.parent === spec.id && o.input === name)) {
          delete spec.inputs[name];
          adjusted.add('forward reference');
        } else {
          visit(child);
        }
      }
      if (typeof spec.next === 'string' && spec.id && later.some((o) => placedId(o) === spec.next && o.after === spec.id)) {
        delete spec.next;
        adjusted.add('forward reference');
      } else {
        visit(spec.next);
      }
    };
    visit(op.block);
  });
}

/**
 * @param {?Object} output  Parsed reply, with view ids.
 * @param {!Map<string, string>} toReal  View ids, to tell a bare number (7) is b7.
 * @param {{blockRefs: function(!Object): ?Array, steps: function(!Object): !Array}} action
 * @param {{placelessNewStack?: boolean}=} options  placelessNewStack: the cursor is on empty workspace (or there are
 *     no blocks), so an insert with no place can only mean a new stack there
 * @returns {{output: ?Object, adjusted: !Array<string>}}
 */
export function normalizeReply(output, toReal, action, {placelessNewStack = false} = {}) {
  if (!output || typeof output !== 'object') return {output, adjusted: []};
  const copy = structuredClone(output);
  const adjusted = new Set();
  const id = (v) => {
    if ((typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && toReal.has(`b${v}`)) {
      adjusted.add('numeric id');
      return `b${v}`;
    }
    return v;
  };
  const refs = action.blockRefs(copy);
  if (refs) refs.splice(0, refs.length, ...refs.map(id));
  const ops = action.steps(copy).flatMap((step) => (Array.isArray(step?.ops) ? step.ops : []))
      .filter((op) => op && typeof op === 'object');
  for (const op of ops) {
    unwrapPlace(op, adjusted);
    if (placelessNewStack && op.op === 'insert' && !['after', 'before', 'parent', 'stack', 'place'].some((k) => k in op)) {
      op.stack = 'new';
      adjusted.add('new stack');
    }
    for (const key of ['after', 'before', 'parent']) if (key in op) op[key] = id(op[key]);
    if (op.op !== 'insert') op.block = id(op.block);
  }
  dropForwardRefs(ops, adjusted);
  return {output: copy, adjusted: [...adjusted]};
}
