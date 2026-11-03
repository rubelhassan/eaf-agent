import * as Blockly from 'blockly/core';
import {Constants} from "../index";
import * as Util from "../util/util";
import {blockTypes} from "../blocks/registry";
import {getOutputManager} from "../output/active.js";
import {madeByWords} from '../blocks/authorship_marks.js';


/** The stack a cursor node is in (its top block id), or null on the workspace. */
function stackOf(node) {
    if (!node) return null;
    if (node.getType() === Blockly.ASTNode.types.WORKSPACE) return null;
    const block = node.getType() === Blockly.ASTNode.types.STACK ? node.getLocation() : node.getSourceBlock?.();
    return block?.getRootBlock?.().id ?? null;
}

export class Speech {
    constructor() {
        this.toggle = false;
        this.readTimeouts = [];
        this.lastStack = undefined;
        this.dirWordMap = {
            [Blockly.ASTNode.types.NEXT]: 'bottom',
            [Blockly.ASTNode.types.PREVIOUS]: 'top',
            [Blockly.ASTNode.types.INPUT]: 'value',
            [Blockly.ASTNode.types.OUTPUT]: 'output',
        }
    }

    /** 'enteredStack' or 'leftStack' when the cursor is in another stack than at the last message. */
    stackCue() {
        const node = Blockly.getMainWorkspace?.()?.getCursor?.()?.getCurNode?.();
        const stack = stackOf(node);
        const before = this.lastStack;
        this.lastStack = stack;
        if (before === undefined || stack === before) return null;
        return stack ? 'enteredStack' : 'leftStack';
    }

    clearPreviousSpeeches() {
        this.readTimeouts.forEach(id => cancelAnimationFrame(id));
        this.readTimeouts = [];
    }

    /**
     * @param {string} text
     * @param {{cue?: string}=} options  cue: an earcon played before the words (with an output manager)
     */
    update(text, {cue} = {}) {
        console.log("Speech: " + text);
        const output = getOutputManager();
        if (output) {
            output.say({text, source: 'navigation', kind: 'navigation', cue: cue || this.stackCue()});
            return;
        }
        this.clearPreviousSpeeches();
        // Schedule single DOM change so screen reader announce exactly once
        const speak = () => {
            const filler   = this.toggle ? ' ' : '\u200B';  // ensure diff
            this.toggle    = !this.toggle;
            const reader   = document.getElementById('blockReader');
            reader.textContent = '';              // reset text
            reader.textContent = `${text}${filler}`;
        };
        const id = requestAnimationFrame(speak);
        this.readTimeouts.push(id);
    }


    getFirstStatementConnection(block) {
        if (!block || !block.inputList) return null;

        for (const input of block.inputList) {
            if (
                input.connection &&
                input.connection.type === Blockly.ConnectionType.NEXT_STATEMENT
            ) {
                return input.connection;
            }
        }

        return null;
    }

    getBaseBlock(node) {
        if (!node) return null;
        if (node.isConnection && node.isConnection()) {
            return node.getLocation().getSourceBlock();
        }
        return typeof node.getSourceBlock === 'function' ? node.getSourceBlock() : null;
    }


    updateBlockReader(disabled, type, blockSvg, state, movement) {
        const prefixTxt = this.moveTypeText(movement);
        const ws = Blockly.getMainWorkspace?.();
        const cursor = ws?.getCursor?.();
        const editMode = !!cursor?.editMode;
        const curNode = cursor?.getCurNode?.();
        const LAYER_MOVE = (
            movement === Constants.SHORTCUT_NAMES.LAYER_IN ||
            movement === Constants.SHORTCUT_NAMES.LAYER_OUT);

        if (editMode && curNode) {
            let placement = 'unknown connection';
            switch (curNode.getType()) {
                case Blockly.ASTNode.types.NEXT :
                    placement = 'bottom connection';
                    break;
                case Blockly.ASTNode.types.PREVIOUS:
                    placement = 'top connection';
                    break;
                case Blockly.ASTNode.types.INPUT:
                    placement = 'value connection';
                    break;
                case Blockly.ASTNode.types.OUTPUT   :
                    placement = 'output connection';
                    break;
                case Blockly.ASTNode.types.FIELD: {
                    const fld = curNode.getLocation();
                    placement = `field ${fld.name || 'unnamed'}`;
                    break;
                }
            }

            const baseBlock = this.getBaseBlock(curNode);
            const baseBlockName = baseBlock ? this.friendlyName(baseBlock) : 'block';

            if (LAYER_MOVE) {
                if (editMode && movement === Constants.SHORTCUT_NAMES.LAYER_OUT) {
                    this.update("No connection to nest out during edit mode")
                    return;
                }

                let containerPhrase = '';
                let container = null;
                if (Util.isContainerBlock(baseBlock)) {
                    container = baseBlock;
                } else {
                    const { surrounding: detectedContainer } = this.containerInfo?.(baseBlock) || {};
                    container = detectedContainer;
                }

                // fallback get direct parent
                if (!container && baseBlock && baseBlock.getParent()) {
                    container = baseBlock.getParent();
                }

                if (container) {
                    containerPhrase = `moving to nested connection of ${this.friendlyName(container)}`;
                    this.update(containerPhrase)
                    return;
                }
            }
            this.update(`${prefixTxt} on ${placement} of ${baseBlockName}`);
            return;
        }

        // workspace or stack level
        if (!blockSvg) {
            const out = type ? `${type} selected` : 'no block found';
            this.update(`${prefixTxt} ${out}`);
            return;
        }


        let outStr = this.friendlyName(blockSvg);

        if (LAYER_MOVE) {
            const blk = this.getBaseBlock(curNode);
            const blkLabel = blk ? this.friendlyName(blk) : 'block';
            let {container, _} = this.containerInfo?.(blk) || {};

            // surrounding block is direct parent
            if (!container && blk && blk.getParent()) {
                container = blk.getParent();
            }

            if (container) {
                outStr = `${prefixTxt} into the first child block ` +
                    `${blkLabel} inside ${this.friendlyName(container)}`
                this.update(outStr);
                return;
            }
        }

        // custom block types describe themselves on focus
        const customFocus = blockTypes.focusText(blockSvg);
        if (customFocus) {
            this.update(`${prefixTxt} ${customFocus}`);
            return;
        }

        // add speech for container‑type blocks
        if (this.getFirstStatementConnection(blockSvg)) {
            outStr = `container block ${outStr}`;
        }

        // custom block types may add to any block's description (e.g. "Answers a question.")
        const suffix = blockTypes.focusSuffix(blockSvg);
        this.update(`${prefixTxt} ${outStr}${suffix ? `. ${suffix}` : ''}`);
    }


    /**
     * Convert a block  into a friendly spoken phrase.
     * @param {!Blockly.Block} blk  A **BlockSvg** (workspace) or **Block** (fly‑out)
     * @returns {string}
     */
     blockToText(blk) {
        if (!blk) {
            return 'unknown block';
        }

        let self = this;

        function fieldPhrase(blk, fieldName, def = '') {
            const f = blk.getField(fieldName);
            return f ? f.getText() : def;
        }

        function inputsPhrase(blk, inputName, placeholder = `(${inputName})`) {
            const inp = blk.getInput(inputName);
            if (!inp) {
                return placeholder;
            }
            const targetBlock = inp.connection && inp.connection.targetBlock();
            if (!targetBlock) {
                return placeholder;
            }
            return self.blockToText(targetBlock);
        }

        const disabledPrefix = '';
        const type= blk.type;

        switch (type) {
            // LOGIC
            case 'controls_if': {
                const cond = inputsPhrase(blk, 'IF0', '(A)');
                return `${disabledPrefix}if ${cond} then`;
            }
            case 'logic_compare': { // (A) equals (B)  OR  1 = 2
                const opWord = {
                    EQ  : 'equals',
                    NEQ : 'does not equal',
                    LT  : 'is less than',
                    LTE : 'is less than or equal to',
                    GT  : 'is greater than',
                    GTE : 'is greater than or equal to',
                }[fieldPhrase(blk, 'OP')] || fieldPhrase(blk, 'OP');
                const left  = inputsPhrase(blk, 'A', '(A)');
                const right = inputsPhrase(blk, 'B', '(B)');
                return `${disabledPrefix}${left} ${opWord} ${right}`;
            }
            case 'logic_operation': {          // (A) and (B)
                const op = fieldPhrase(blk, 'OP', 'and').toLowerCase();
                return `${disabledPrefix}${inputsPhrase(blk,'A','(A)')} 
                ${op} ${inputsPhrase(blk,'B','(B)')}`;
            }
            case 'logic_negate':
                return `${disabledPrefix}not ${inputsPhrase(blk, 'BOOL', '(condition)')}`;
            case 'logic_boolean':
                return `${disabledPrefix}${fieldPhrase(blk, 'BOOL', 'true')}`;
            case 'logic_ternary': {
                const test= inputsPhrase(blk,'IF','(test)');
                const ifThen= inputsPhrase(blk,'THEN','(A)');
                const ifElse= inputsPhrase(blk,'ELSE','(B)');
                return `${disabledPrefix}if ${test} then ${ifThen} else ${ifElse}`;
            }
            // LOOPS
            case 'controls_repeat_ext': {
                const times = inputsPhrase(blk, 'TIMES', '(A)');
                return `${disabledPrefix}repeat ${times} times`;
            }
            case 'controls_whileUntil': {
                const mode = fieldPhrase(blk,'MODE','while');
                const cond = inputsPhrase(blk,'BOOL','(condition)');
                return `${disabledPrefix}repeat ${mode} ${cond}`;
            }
            case 'controls_for': {
                const varName = fieldPhrase(blk,'VAR','i');
                const from = inputsPhrase(blk,'FROM','(A)');
                const to   = inputsPhrase(blk,'TO','(B)');
                const by   = inputsPhrase(blk,'BY','(C)');
                return `${disabledPrefix}count with ${varName} from ${from} to ${to} by ${by}`;
            }
            case 'controls_flow_statements':
                return `${disabledPrefix}${fieldPhrase(blk,'FLOW','break out')} of loop`;
            // MATH
            case 'math_number':
                return `${disabledPrefix}${fieldPhrase(blk,'NUM','number')}`;
            case 'math_arithmetic': {
                const sym = {
                    ADD : '+', MINUS : '-', MULTIPLY : '×', DIVIDE : '÷', POWER : '^'
                }[fieldPhrase(blk,'OP')] || fieldPhrase(blk,'OP');
                return `${disabledPrefix}${inputsPhrase(blk,'A','(A)')} 
                ${sym} ${inputsPhrase(blk,'B','(B)')}`;
            }
            case 'math_single': {
                const op = fieldPhrase(blk,'OP','square root of');
                return `${disabledPrefix}${op} ${inputsPhrase(blk,'NUM','(A)')}`;
            }
            case 'math_modulo':
                return `${disabledPrefix}remainder of ${inputsPhrase(blk,'DIVIDEND','(A)')} 
                divided by ${inputsPhrase(blk,'DIVISOR','(B)')}`;
            case 'math_random_int':
                return `${disabledPrefix}random integer from ${inputsPhrase(blk,'FROM','(A)')} 
                to ${inputsPhrase(blk,'TO','(B)')}`;
            case 'math_random_float':
                return `${disabledPrefix}random fraction`;
            // TEXT
            case 'text':
                return `${disabledPrefix}text value`;
            case 'text_join': {
                const n = blk.itemCount_ || 2;
                return `${disabledPrefix}create text with ${n} items`;
            }
            case 'text_length':
                return `${disabledPrefix}length of ${inputsPhrase(blk,'VALUE','(text)')}`;
            case 'text_print':
                return `${disabledPrefix}print ${inputsPhrase(blk,'TEXT','(text)')}`;
            // LISTS
            case 'lists_create_with': {
                const n = blk.itemCount_ || 0;
                if (n === 0)
                    return `${disabledPrefix}create empty list`;
                return `${disabledPrefix}create list with ${n} items`;
            }
            case 'lists_length':
                return `${disabledPrefix}length of list`;
            // VARIABLES & PROCEDURES
            case 'variables_get':
                return `${disabledPrefix}get variable ${fieldPhrase(blk,'VAR','name')}`;
            case 'variables_set':
                return `${disabledPrefix}set variable ${fieldPhrase(blk,'VAR','name')} 
                to ${inputsPhrase(blk,'VALUE','(value)')}`;
            default:
                return `${disabledPrefix}${blockTypes.describe(blk) ?? type}`;
        }
    }

    moveTypeText(type) {
        if (!type) return "";

        switch (type) {
            case Constants.SHORTCUT_NAMES.NEXT:
                return "moving down";
            case Constants.SHORTCUT_NAMES.PREVIOUS:
                return "moving up";
            case Constants.SHORTCUT_NAMES.IN:
                return "moving right";
            case Constants.SHORTCUT_NAMES.OUT:
                return "moving left";
            case Constants.SHORTCUT_NAMES.LAYER_IN:
                return "nesting in";
            case Constants.SHORTCUT_NAMES.LAYER_OUT:
                return "nesting out";
            default:
                return "";
        }
    }

    process(block, movement, state) {
        if (!block && !movement) {
            return;
        }

        if (block) {
            if (block.getType() === Blockly.ASTNode.types.STACK ||
                block.getType() === Blockly.ASTNode.types.WORKSPACE) {
                this.updateBlockReader(null, block.getType(), null, state, movement);
            } else {
                let srcBlock = block.getSourceBlock();
                this.updateBlockReader(!srcBlock.isEnabled(), srcBlock.type, srcBlock, state, movement);
            }
        } else {
            this.updateBlockReader(null, null, null, state, movement);
        }
    }

    announceCategory(category, direction = '') {
        let postfix = '';
        if (!category) return;
        const name = (typeof category.getName === 'function')
            ? category.getName()
            : category.name_;          // fallback

        let prefix;
        switch (direction) {
            case Constants.SHORTCUT_NAMES.NEXT:
                prefix = 'Move to next category';
                break;
            case Constants.SHORTCUT_NAMES.PREVIOUS:
                prefix = 'Move to previous category';
                break;
            case Constants.SHORTCUT_NAMES.IN:
                prefix = 'Entered category';
                break;
            case Constants.SHORTCUT_NAMES.OUT:
                prefix = 'Back to category';
                break;
            default:
                prefix = 'Toolbox category';
                postfix = 'selected'
        }

        const note = blockTypes.categoryNote(category, Blockly.getMainWorkspace?.());
        this.update(`${prefix}: ${name}${note ? `, ${note}` : ''} ${postfix}`);
    }


    announceFlyoutItem(node, direction = '') {
        if (!node) {
            const edge = (direction === Constants.SHORTCUT_NAMES.PREVIOUS)
                ? 'top'
                : 'bottom';
            this.update(`Reached ${edge} of flyout`);
            return;
        }

        let label = '';
        let disabledPrefix = '';
        switch (node.getType()) {
            case Blockly.ASTNode.types.BUTTON: {
                const btn = node.getLocation();
                label = btn.getText().trim();
                break;
            }

            default: {
                const blockSvg = node.getSourceBlock();
                disabledPrefix = blockSvg.isEnabled && !blockSvg.isEnabled() ? 'disabled ' : '';
                label = this.blockToText(blockSvg);
                // fallback
                if (!label || label.toLowerCase().startsWith('custom')) {
                    label =
                        blockSvg.toString().trim() ||
                        (blockSvg.tooltip && blockSvg.tooltip.trim()) ||
                        blockSvg.type;
                }
            }
        }

        let categoryName = '';
        const categoryObj = Blockly.getMainWorkspace()
            ?.getToolbox()
            ?.getSelectedItem();
        if (categoryObj) {
            categoryName = (typeof categoryObj.getName === 'function')
                ? categoryObj.getName()
                : (categoryObj.name_ || '');
        }
        // fallback
        if (!categoryName) {
            const labelEl = document.querySelector(
                '.blocklyTreeSelected .blocklyTreeRowContentContainer .blocklyTreeLabel'
            );
            if (labelEl) categoryName = labelEl.textContent.trim();
        }
        const dirstrt = (direction === Constants.SHORTCUT_NAMES.PREVIOUS)
            ? 'back'
            : '';

        const note = node.getSourceBlock ? blockTypes.flyoutNote(node.getSourceBlock()) : null;
        // Choices shown outside the toolbox (e.g. a question's) have no category.
        const where = categoryName ? ` under ${categoryName} category` : '';
        const phrase = ['Move', dirstrt, 'to', disabledPrefix, 'item', `${label}${note ? `, ${note}` : ''}${where}`]
            .filter(Boolean).join(' ');
        this.update(phrase);
    }


    friendlyName(blkSvg) {
        if (!blkSvg) return '';
        let txt = this.blockToText(blkSvg);
        if (!txt || txt.toLowerCase().startsWith('custom')) {
            txt = blkSvg.toString().trim() ||
                (blkSvg.tooltip && blkSvg.tooltip.trim()) ||
                blkSvg.type;
        }
        return txt + ' block';
    };

    announceInsertedBlock(newBlock, originalBlock, dirKey='') {
        if (!newBlock) {
            return;
        }

        const newBlockSvg = newBlock.getSourceBlock();
        const newLabel = this.friendlyName(newBlockSvg);

        if (!originalBlock) {
            this.update(`Inserted ${newLabel}`);
            return;
        }

        const refLabel = this.friendlyName(originalBlock);
        const dirWordMap = {
            TOP   : 'above',
            BOTTOM: 'below',
            RIGHT : 'to the right of',
        };
        const dirWord = dirWordMap[dirKey] || 'near';

        this.update(`${newLabel} inserted ${dirWord} ${refLabel}`);
    }


    announceMark(node, originalBlock = null, dirKey = '') {
        if (!node) {
            return;
        }
        if (originalBlock && dirKey) {
            const dirWordMap = {
                TOP   : 'top',
                BOTTOM: 'bottom',
                RIGHT : 'right',
            };
            const dirWord = dirWordMap[dirKey] || 'near';
            const refLabel = this.friendlyName(originalBlock);
            this.update(`Marked ${dirWord} connection of ${refLabel}`);
            return;
        }

        if (node.getType() === Blockly.ASTNode.types.WORKSPACE) {
            this.update('Workspace location marked');
            return;
        }

        this.update(`Marked top connection of ` +
            `${this.friendlyName(node.getSourceBlock && node.getSourceBlock())}`);
    }

    announceReturnToWorkspace(node) {
        let phrase = 'Toolbox closed. ';

        if (node === false) {
            phrase = "";
        }

        if (!node) {
            this.update(`${phrase} Cursor back on workspace`);
            return;
        }

        if (node.getType() === Blockly.ASTNode.types.WORKSPACE) {
            this.update(`${phrase} Cursor back on workspace`);
            return;
        }

        const blk = node.getSourceBlock && node.getSourceBlock();
        phrase += `Cursor back on ${this.friendlyName(blk)}`;
        this.update(phrase);
    }

    ordinalWord(n) {
        const r10 = n % 10, r100 = n % 100;
        if (r10 === 1 && r100 !== 11) return `${n}st`;
        if (r10 === 2 && r100 !== 12) return `${n}nd`;
        if (r10 === 3 && r100 !== 13) return `${n}rd`;
        return `${n}th`;
    }

    containerInfo(block) {
        if (!block) {
            return {
                surrounding: null,
                indexInside: null,
                stackIndex: null
            };
        }

        const root = block.getRootBlock(); // top-block of current stack
        const stacks= block.workspace.getTopBlocks(true); // array of top stack blocks in visual order
        const stackIndex = stacks.indexOf(root) + 1 || null;

        // value block then return with attached parent
        if (block.outputConnection && block.outputConnection.isConnected()) {
            const parent = block.outputConnection.targetBlock();
            return {
                surrounding: parent,
                indexInside: null,
                stackIndex
            };
        }

        // statement block of a container block
        if (block.getPreviousBlock()) {
            // walks up upward until joining connection to parent is found
            let child = block;
            let parent = child.getParent();
            while (parent) {
                const prevConn= child.previousConnection;
                if (prevConn && prevConn.targetConnection &&
                    prevConn.targetConnection.type === Blockly.NEXT_STATEMENT) {
                    break; // found container
                }
                child  = parent;
                parent = parent.getParent();
            }

            if (parent) {
                // first block plugged into that statement input
                const stmtInput = parent.inputList.find(
                    inp => inp.connection && inp.connection.type === Blockly.NEXT_STATEMENT);
                let idx = 0;
                let firstBlock = stmtInput && stmtInput.connection ? stmtInput.connection.targetBlock() : null;
                // traverse and count position until current block not found
                while (firstBlock) {
                    if (!firstBlock.outputConnection && !firstBlock.isShadow()) {
                        idx++;
                        if (firstBlock === block) break;
                    }
                    firstBlock = firstBlock.getNextBlock();
                }
                return {surrounding: parent, indexInside: idx || null, stackIndex};
            }
        }

        // only block in stack maybe
        return {
            surrounding: block.getParent() || null,
            indexInside: null,
            stackIndex};
    }

    announceCursorLoc(node, {after} = {}) {
        if (!node) {
            this.update('Cursor is on workspace.'); return;
        }

        const srcBlock = node.getSourceBlock && node.getSourceBlock();
        const containerBlockInfo= this.containerInfo(srcBlock);
        let phrase  = '';

        switch (node.getType()) {
            case Blockly.ASTNode.types.STACK:
                phrase = `The cursor is on the ${this.ordinalWord(containerBlockInfo.stackIndex)} stack`;
                this.update(phrase);
                return;
            case Blockly.ASTNode.types.WORKSPACE:
                phrase = `The cursor is on the workspace`;
                this.update(phrase);
                return;
            case Blockly.ASTNode.types.BLOCK:
                phrase = `The cursor is on block: ${this.friendlyName(srcBlock)}`; break;
            case Blockly.ASTNode.types.FIELD: {
                const fld = node.getLocation();
                phrase = `The cursor is on field ${fld.name || 'unnamed'} of ${this.friendlyName(srcBlock)}`;
                break;
            }
            case Blockly.ASTNode.types.NEXT:
            case Blockly.ASTNode.types.PREVIOUS:
            case Blockly.ASTNode.types.INPUT:
            case Blockly.ASTNode.types.OUTPUT: {
                const dir = this.dirWordMap[node.getType()];
                phrase = `The cursor is on the ${dir} connection of ${this.friendlyName(srcBlock)}`;
                break;
            }
            default:
                phrase = 'Cursor location unknown.';
        }

        if (containerBlockInfo.surrounding) {
            if (containerBlockInfo.indexInside != null) {
                phrase += `, ${this.ordinalWord(containerBlockInfo.indexInside)} block inside ${this.friendlyName(containerBlockInfo.surrounding)}`;
            } else {
                phrase += `, inside of ${this.friendlyName(containerBlockInfo.surrounding)}`;
            }
        }

        // todo: add stack index for now, when stack labeling code merge change here
        if (containerBlockInfo.stackIndex != null) {
            phrase += `, under the ${this.ordinalWord(containerBlockInfo.stackIndex)}) stack`;
        }

        const ending = after ?? madeByWords(srcBlock);
        this.update(ending ? `${phrase}, ${ending}` : phrase);
    }

    announceEditModeToggle(editMode, curNode) {
        if (editMode === null) {
            this.update("Edit mode can be activated on blocks only");
            return;
        }

        const block = curNode?.getSourceBlock?.();

        if (block) {
            const label = this.friendlyName(block);
            const hint = editMode ? blockTypes.editLock(block) : null;
            const phrase = editMode
                ? `Entering edit mode on ${label}${hint ? `. ${hint}` : ''}`
                : `Leaving edit mode on ${label}`;
            this.update(phrase);
        } else {
            const fallback = editMode ? "Entering edit mode" : "Leaving edit mode";
            this.update(fallback);
        }
    }
}
