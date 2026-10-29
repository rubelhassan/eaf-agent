// Op list v4: v3 plus new stacks and stack names. The harness picks where a new stack goes.

export const OPS_V4 = `OPS (ids are text, as in the program, and must come from it, except ids you give new blocks)
{"op":"setField","block":ID,"field":NAME,"value":V}   a variable field takes the variable's name
{"op":"insert","block":NEW, PLACE}
{"op":"move","block":ID, PLACE}       moves one block with what is plugged into it
{"op":"delete","block":ID}            blocks below a deleted statement move up
{"op":"addBranch","block":ID,"branch":"elseif"|"else"}   on an if block; a new else if gets inputs IFn and DOn
{"op":"nameStack","block":ID,"name":TEXT}   names the stack the block is in; "" removes the name
PLACE is one of these keys, written directly in the op: "after":ID | "before":ID | "parent":ID,"input":NAME | "stack":"new"
"stack":"new" starts a new stack, at the cursor when it is on empty workspace, else below the cursor's stack. It may take "name":TEXT.
NEW: {"type":TYPE,"id":NEW_ID,"fields":{NAME:V},"inputs":{NAME:NEW},"next":NEW}   inputs and next nest new blocks, never ids
Examples (made-up ids): {"op":"move","block":"b91","before":"b90"}
{"op":"insert","block":{"type":"math_number","fields":{"NUM":2}},"parent":"b92","input":"B"}
A value input holds one block, so placing into a filled one replaces and removes it.
In a statement input the block goes at the end; to put it first, use "before" the first block.
Use only toolbox block types. Never change a question block or a learner's answer.`;
