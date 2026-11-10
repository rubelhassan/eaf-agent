// @ts-check
// Program code for the runner. Every caller compiles with the same overrides, so a program prints, asks and stops
// the same way in the app, the assessment and the eval. The code only talks to `$run` (see run_core.js).
//
// Block ids come from task files, so they never go into the code: each is a number into the id table returned with
// the code. `$run` can't clash with a program's names, since Blockly makes those from letters, digits and _ only.

// Blockly's JavaScript operator orders.
const ORDER_NONE = 99;
const ORDER_FUNCTION_CALL = 2;

const PROCEDURE_DEFS = ['procedures_defreturn', 'procedures_defnoreturn'];
const OVERRIDDEN = ['text_print', 'text_prompt', 'text_prompt_ext', 'procedures_callreturn', ...PROCEDURE_DEFS];

/**
 * @param {!Blockly.Workspace} workspace
 * @param {!Object} generator  Blockly's JavaScript generator (the host's, so the plugin bundle doesn't carry one)
 * @param {{input?: ('ask'|'list')}=} options  ask: each prompt awaits the learner's answer, so the code is async
 * @returns {{code: string, blockIds: !Array<string>}}  blockIds: the id table the code's numbers index
 */
export function compileProgram(workspace, generator, {input = 'list'} = {}) {
  const blockIds = [];
  const indexes = new Map();
  const indexOf = (block) => {
    if (!indexes.has(block.id)) indexes.set(block.id, blockIds.push(block.id) - 1);
    return indexes.get(block.id);
  };
  const saved = save(generator);
  try {
    instrument(generator, {ask: input === 'ask', indexOf, saved});
    return {code: generator.workspaceToCode(workspace), blockIds};
  } finally {
    restore(generator, saved);
  }
}

function save(generator) {
  return {
    trap: generator.INFINITE_LOOP_TRAP,
    prefix: generator.STATEMENT_PREFIX,
    ownInjectId: Object.prototype.hasOwnProperty.call(generator, 'injectId') ? generator.injectId : null,
    blocks: Object.fromEntries(OVERRIDDEN.map((type) => [type, generator.forBlock[type]])),
  };
}

function restore(generator, saved) {
  generator.INFINITE_LOOP_TRAP = saved.trap;
  generator.STATEMENT_PREFIX = saved.prefix;
  if (saved.ownInjectId) generator.injectId = saved.ownInjectId;
  else delete generator.injectId;
  Object.assign(generator.forBlock, saved.blocks);
}

function instrument(generator, {ask, indexOf, saved}) {
  const forBlock = generator.forBlock;
  // Blockly would put the raw id in quotes here; a number can't break out of anything.
  generator.injectId = (message, block) => message.replace(/%1/g, String(indexOf(block)));
  // Each statement and each loop round is one step, and says which block runs.
  generator.STATEMENT_PREFIX = '$run.step(%1);\n';
  generator.INFINITE_LOOP_TRAP = '$run.step(%1);\n';
  forBlock['text_print'] = (block, g) => `$run.print(${g.valueToCode(block, 'TEXT', ORDER_NONE) || "''"}, ${indexOf(block)});\n`;
  const prompt = (block, g) => {
    const message = block.getField('TEXT') ? g.quote_(block.getFieldValue('TEXT')) :
      g.valueToCode(block, 'TEXT', ORDER_NONE) || "''";
    const answer = `${ask ? 'await ' : ''}$run.input(${message}, ${indexOf(block)})`;
    const code = block.getFieldValue('TYPE') === 'NUMBER' ? `Number(${answer})` : ask ? `(${answer})` : answer;
    return [code, ORDER_FUNCTION_CALL];
  };
  forBlock['text_prompt'] = prompt;
  forBlock['text_prompt_ext'] = prompt;
  if (ask) makeProceduresAsync(forBlock, saved.blocks);
}

/** A prompt can sit inside a procedure, so procedures are async and every call waits for them. */
function makeProceduresAsync(forBlock, original) {
  // The no-return call is built from this one, so it waits too.
  const call = original['procedures_callreturn'];
  forBlock['procedures_callreturn'] = (block, g) => [`(await ${call(block, g)[0]})`, ORDER_FUNCTION_CALL];
  for (const type of PROCEDURE_DEFS) {
    const define = original[type];
    forBlock[type] = (block, g) => {
      const result = define(block, g);
      // A block comment comes first as // lines.
      for (const [key, text] of Object.entries(g.definitions_)) {
        if (key.startsWith('%')) g.definitions_[key] = text.replace(/^((?:\/\/.*\n)*)function /, '$1async function ');
      }
      return result;
    };
  }
}
