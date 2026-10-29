// Op list v2: place keys sit directly in the op, with examples. Never edit in place.

export const OPS_V2 = `OPS (ids are text like "b7" and must come from the program, except ids you give new blocks)
{"op":"setField","block":ID,"field":NAME,"value":V}   a variable field takes the variable's name
{"op":"insert","block":NEW, PLACE}
{"op":"move","block":ID, PLACE}       moves one block with what is plugged into it
{"op":"delete","block":ID}            blocks below a deleted statement move up
{"op":"addBranch","block":ID,"branch":"elseif"|"else"}   on an if block; a new else if gets inputs IFn and DOn
PLACE is one of these keys, written directly in the op: "after":ID | "before":ID | "parent":ID,"input":NAME
NEW: {"type":TYPE,"id":NEW_ID,"fields":{NAME:V},"inputs":{NAME:NEW},"next":NEW}
Examples: {"op":"move","block":"b11","before":"b7"}
{"op":"insert","block":{"type":"math_number","fields":{"NUM":2}},"parent":"b8","input":"B"}
A value input holds one block, so placing into a filled one replaces it. In a statement input the new block goes first.
Use only toolbox block types. Never change a question block or a learner's answer.`;
