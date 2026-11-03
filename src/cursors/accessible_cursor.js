import * as Blockly from 'blockly/core';
import {ASTNode} from "blockly/core";
import {Constants} from "../index";
import * as Util from "../util/util"

/**
 * Class for an accessible cursor.
 * @constructor
 * @extends {Blockly.Cursor}
 */
export class AccessibleCursor extends Blockly.Cursor {
    /**
     * Constructor for an accessible cursor.
     */
    constructor() {
        super();
        this.lastStack = null;
        this.editMode = false;
        this.editingBlock = null;
        this.editConnection = null;
        this.shouldSuppressScroll = false;
        this.pastNode = null;
        this.pastNodeBlockId = null;
    }

    // prevent scroll to current view
    suppressNextScroll() {
        this.shouldSuppressScroll = true;
    }

    setSpeechListener(speech) {
        this.speech = speech;
    }

    setEditingBlock(block) {
        if (this.editMode) {
            this.editingBlock = block;
            this.topConnection();
            if (this.speech) {
                this.speech.update("Editing selection is updated to newly created block")
            }
        }
    }

    toggleEditMode() {
        if (this.editMode) {
            this.editMode = false;
            if (!this.isBlockNode(this.getCurNode())) {
                this.setCurNode(this.editingBlock);
            }
            this.editingBlock = null;
            this.editConnection = null;
            return false;
        } else {
            this.editingBlock = this.getCurrentBlock();
            if (this.editingBlock) {
                this.editMode = true;
                console.log("edit mode enabled");
                this.topConnection();
                return true;
            }
        }
        return null;
    }

    isBlockNode(curNode) {
        return curNode && curNode.getType() === ASTNode.types.BLOCK;
    }

    getCurrentBlock() {
        let curNode = this.getCurNode();
        if (curNode && curNode.getType() === ASTNode.types.BLOCK) {
            return curNode;
        } else {
            return null;
        }
    }

    isValidConnectionNode(node) {
        if (!node) {
            return false
        }

        const location = node.getLocation();
        const type = node ? node.getType() : null;
        switch (type) {
            case Blockly.ASTNode.types.INPUT: {
                const connection = location;
                return connection.type === Blockly.NEXT_STATEMENT ||  connection.type === Blockly.PREVIOUS_STATEMENT ||  connection.type === Blockly.INPUT_VALUE;
            }
            case Blockly.ASTNode.types.NEXT:
                return true;
            case Blockly.ASTNode.types.PREVIOUS:
                return true;
            default:
                return false;
        }

    }


    isValidNestedConnectionNode(node) {
        if (!node) {
            return false
        }
        const location = node.getLocation();
        const type = node ? node.getType() : null;
        switch (type) {
            case Blockly.ASTNode.types.INPUT: {
                const connection = location;
                return connection.type === Blockly.NEXT_STATEMENT ||  connection.type === Blockly.PREVIOUS_STATEMENT;
            }
            case Blockly.ASTNode.types.NEXT:
                return true;
            case Blockly.ASTNode.types.PREVIOUS:
                return true;
            default:
                return false;
        }

    }

    topConnection() {
        if (!this.editingBlock) return null;
        let newNode = this.getPrevNode(this.editingBlock, this.isValidConnectionNode.bind(this));

        if (!newNode) {
            const blk = this.editingBlock.getSourceBlock();
            if (blk) {
                for (const inp of blk.inputList) {
                    if (inp.connection && inp.connection.type === Blockly.ConnectionType.INPUT_VALUE) {
                        newNode = Blockly.ASTNode.createConnectionNode(inp.connection);
                        break;
                    }
                }

                // select value field for single-value block
                if (!newNode && blk.outputConnection) {
                    const seq = this._buildInnerNodeSeq(blk);
                    newNode = seq.find(n => n.getType() === Blockly.ASTNode.types.FIELD);
                }

            }
        }

        if (newNode) {
            this.setCurNode(newNode);
        }
        return newNode;
    }

    bottomConnection() {
        if (!this.editingBlock) return null;
        let newNode = this.getNextNode(this.editingBlock, this.isValidConnectionNode.bind(this));
        if (newNode) {
            this.setCurNode(newNode);
        }
        return newNode;
    }

    _buildInnerNodeSeq(blk) {
        const seq = [];
        if (!blk) {
            return seq;
        }

        // left most output connection
        if (blk.outputConnection) {
            seq.push(Blockly.ASTNode.createConnectionNode(blk.outputConnection));
        }

        blk.inputList.forEach(inp => {
            inp.fieldRow.forEach(f => {
                // filter editable field
                if (typeof f.isCurrentlyEditable === 'function' && f.isCurrentlyEditable()) {
                    seq.push(Blockly.ASTNode.createFieldNode(f));
                }
            });
            if (inp.connection &&
                inp.connection.type === Blockly.ConnectionType.INPUT_VALUE) {
                seq.push(Blockly.ASTNode.createConnectionNode(inp.connection));
            }
        });


        return seq;
    }

    rightConnection() {
        if (!this.editingBlock) return null;
        let newNode = null;
        if (this.hasStatementInputFromASTNode(this.editingBlock) ||
            (this.hasSingleValueBlock(this.editingBlock) && !this.isOutputBlock(this.editingBlock))
        ) {
            const block = this.editingBlock.getSourceBlock?.();
            if (block) {
                for (const input of block.inputList) {
                    const conn = input.connection;
                    if (conn && conn.type === Blockly.ConnectionType.INPUT_VALUE) {
                        newNode = Blockly.ASTNode.createConnectionNode(conn);
                        if (this.isValidConnectionNode(newNode)) {
                            this.setCurNode(newNode);
                            return newNode;
                        }
                    }
                }
            }
        }

        // if current block has value input the skip
        if (!this.hasStatementInputFromASTNode(this.editingBlock) && !this.hasFullParentBlock(this.editingBlock)) {
            newNode = this.getNextRightNode(this.editingBlock, this.isValidConnectionNode.bind(this));
        }


        if (!newNode) {
            const blk = this.editingBlock.getSourceBlock();
            if (blk) {
                const seq = this._buildInnerNodeSeq(blk);
                // current location of cursor in inputs
                const curLoc  = this.getCurNode()?.getLocation();
                const curIdx  = seq.findIndex(n => n.getLocation() === curLoc);
                if (curIdx > -1 && curIdx < seq.length - 1) {
                    newNode = seq[curIdx + 1];
                }
            }
        }

        if (newNode) {
            this.setCurNode(newNode);
        }
        return newNode;
    }

    nestedConnection() {
        if (!this.editingBlock) return null;

        let newNode = this.getLayerInNode(this.editingBlock, this.isValidNestedConnectionNode.bind(this));

        if (!newNode) {
            const block = this.editingBlock.getSourceBlock?.();
            if (block) {
                for (const input of block.inputList) {
                    const conn = input.connection;
                    if (conn && conn.type === Blockly.ConnectionType.NEXT_STATEMENT) {
                        newNode = Blockly.ASTNode.createConnectionNode(conn);
                        break;
                    }
                }
            }
        }

        if (!newNode && !this.hasStatementInputFromASTNode(this.editingBlock)) {
            newNode = this.findFirstBlockInOrNext(this.editingBlock.in(), this.isValidNestedConnectionNode.bind(this));
        }

        if (newNode) {
            this.setCurNode(newNode);
        }

        return newNode;
    }

    isValidVerticalNode(node) {
        console.log("call isValidNode, type=", node ? node.getType() : 'none')
        if (!node) {
            return false
        }

        const location = node.getLocation();
        const type = node ? node.getType() : null;
        console.log("call isValidNode, node type=", type)
        switch (type) {
            case Blockly.ASTNode.types.BLOCK:
                return true;
            case Blockly.ASTNode.types.STACK:
                return true;
            // return !(location as Blockly.Block).outputConnection?.isConnected();
            // case Blockly.ASTNode.types.INPUT: {
            //     const connection = location.Connection;
            //     return (
            //         connection.type === Blockly.NEXT_STATEMENT && !connection.isConnected()
            //     );
            // }
            // case Blockly.ASTNode.types.NEXT:
            //     return !location.isConnected();
            // case Blockly.ASTNode.types.PREVIOUS:
            //     return !location.isConnected();
            default:
                return false;
        }

    }

    isValidLayerNode(node) {
        if (!node) {
            return false
        }
        const type = node ? node.getType() : null;
        console.log("call isValidLayerNode, node type=", type)
        switch (type) {
            case Blockly.ASTNode.types.BLOCK:
                return true;
            case Blockly.ASTNode.types.STACK:
                return true;
            case Blockly.ASTNode.types.WORKSPACE:
                return true;
            case Blockly.ASTNode.types.OUTPUT:
                return true;
            default:
                return false;
        }

    }

    isValidHorizontalNode(node) {
        if (!node) {
            return false
        }

        const location = node.getLocation();
        const type = node ? node.getType() : null;
        console.log("call isValidInNode, node type=", type)
        switch (type) {
            case Blockly.ASTNode.types.BLOCK:
                return true;

            case Blockly.ASTNode.types.STACK:
                return true;

            case Blockly.ASTNode.types.WORKSPACE:
                return true;
            // case Blockly.ASTNode.types.FIELD: {
            //     const field = node.getLocation();
            //     return !(
            //         field.getSourceBlock() && field.getSourceBlock().isSimpleReporter() && field.isFullBlockField()
            //     );
            // }
            default:
                return false;
        }

    }

    isValidDNode(node) {
        if (!node) {
            return false
        }

        const location = node.getLocation();
        const type = node ? node.getType() : null;
        console.log("call isValidDoNode, node type=", type)
        switch (type) {
            case Blockly.ASTNode.types.BLOCK:
                return true;

            case Blockly.ASTNode.types.STACK:
                return true;

            case Blockly.ASTNode.types.WORKSPACE:
                return true;

            // case Blockly.ASTNode.types.OUTPUT:
            //     return true;
            //
            // case Blockly.ASTNode.types.INPUT: {
            //     console.log("input result: " + !location.isConnected())
            //     return !location.isConnected();
            // }

            case Blockly.ASTNode.types.FIELD: {
                const field = node.getLocation();
                return !(
                    field.getSourceBlock() && field.getSourceBlock().isSimpleReporter() && field.isFullBlockField()
                );
            }
            default:
                return false;
        }

    }

    getNextNode(curNode, isValid) {
        console.log("call getNextNode, type=", curNode ? curNode.getType() : 'none')
        if (!curNode) {
            return null;
        }

        let newNode = curNode.next();
        console.log("call getNextNode next, type=", newNode ? newNode.getType() : 'none')

        if (isValid(newNode)) {
            return newNode;
        } else if (newNode) {
            return this.getNextNode(newNode, isValid);
        }

        return null;
    }

    outputConnection(curNode, isValid) {
        if (!curNode) {
            return null;
        }
        let newNode = curNode.in();
        if (!newNode) {
            newNode = curNode.next();
        }
        if (isValid(newNode)) {
            return newNode;
        } else if (newNode) {
            return this.getInNode(newNode, isValid);
        }
        return null;
    }

    outputConnectionNode(curNode, isValid) {
        console.log("call outputConnection, type=", curNode ? curNode.getType() : 'none')
        if (!curNode) {
            return null;
        }

        let newNode = curNode.in();
        console.log("call outputConnection in, type=", newNode ? newNode.getType() : 'none')

        if (!newNode && (curNode.getType() === Blockly.ASTNode.types.OUTPUT ||
            curNode.getType() === Blockly.ASTNode.types.PREVIOUS ||
            curNode.getType() === Blockly.ASTNode.types.FIELD)) {
            newNode = curNode.next();
            console.log("call outputConnection(output) next, type=", newNode ? newNode.getType() : 'none')
        }

        if (isValid(newNode)) {
            if (curNode.getType() === Blockly.ASTNode.types.OUTPUT) {
                return newNode;
            }
        } else if (newNode) {
            return this.getInNode(newNode, isValid);
        }

        return null;
    }

    getInNode(curNode, isValid) {
        console.log("call getInNode, type=", curNode ? curNode.getType() : 'none')
        if (!curNode) {
            return null;
        }

        let newNode = curNode.in();
        console.log("call getInNode in, type=", newNode ? newNode.getType() : 'none')

        if (!newNode && (curNode.getType() === Blockly.ASTNode.types.OUTPUT ||
            curNode.getType() === Blockly.ASTNode.types.PREVIOUS)) {
            newNode = curNode.next();
            console.log("call getInNode(output) next, type=", newNode ? newNode.getType() : 'none')
        }

        if (isValid(newNode)) {
            return newNode;
        } else if (newNode) {
            return this.getInNode(newNode, isValid);
        }

        return null;
    }


    /**
     * Recursively prints all blocks connected to and inside a given block.
     * @param {Blockly.Block} block The block to start from.
     * @param {number} depth Used for indentation.
     */
    /**
     * Find the next connection, field, or block.
     *
     * @returns The next element, or null if the current node is not set or there
     *     is no next value.
     */
    next() {
        if (this.editMode) {
            this.editConnection = "BOTTOM";
            return this.bottomConnection();
        }

        console.log("AC Cursor S: next");
        const curNode = this.getCurNode();
        if (!curNode) {
            return null;
        }

        let newNode = this.getNextNode(curNode, this.isValidVerticalNode.bind(this)) || this.valueFallback(curNode, 'next');

        if (newNode) {
            console.log("NEXT Node Final Type:" + newNode.getType());
            this.setCurNode(newNode);
        }

        if (newNode && newNode.getType() === Blockly.ASTNode.types.STACK) {
            this.lastStack = newNode;
        }

        return newNode;
    }


    findFirstBlockInOrNext(curNode, isValid) {
        console.log("call findFirstBlockInOrNext, type=", curNode ? curNode.getType() : 'none')
        if (!curNode) {
            return null;
        }

        let newNode = curNode.in();
        console.log("call findFirstBlockInOrNext in, type=", newNode ? newNode.getType() : 'none')

        if (!newNode) {
            newNode = curNode.next();
        }

        if (isValid(newNode)) {
            return newNode;
        } else if (newNode) {
            return this.findFirstBlockInOrNext(newNode, isValid);
        }

        return null;
    }

    getLayerInNode(curNode, isValid) {
        console.log("call getDiagInNode, type=", curNode ? curNode.getType() : 'none')
        if (!curNode) {
            return null;
        }

        let newNode = curNode.in();
        console.log("call getDiagInNode in, type=", newNode ? newNode.getType() : 'none')

        if (!newNode && curNode.getType() !== Blockly.ASTNode.types.OUTPUT) {
            newNode = curNode.next();
            console.log("call getDiagInNode(output) next, type=", newNode ? newNode.getType() : 'none')
        }

        if (isValid(newNode)) {
            return newNode;
        } else if (newNode && newNode.next()) {
            return this.getInNode(newNode.next(), isValid);

            // return this.findFirstBlockInOrNext(newNode.next(), isValid);
        }

        return null;
    }

    getDiagNode(curNode, isValid) {
        console.log("call getDiagNode, type=", curNode ? curNode.getType() : 'none')
        if (!curNode) {
            return null;
        }

        let newNode = curNode.in();
        console.log("call getDiagNode in, type=", newNode ? newNode.getType() : 'none')

        if (!newNode && (curNode.getType() === Blockly.ASTNode.types.PREVIOUS)) {
            newNode = curNode.next();
            console.log("call getDiagNode(output) next, type=", newNode ? newNode.getType() : 'none')
        }

        if (isValid(newNode)) {
            return newNode;
        } else if (newNode) {
            return this.getDiagNode(newNode, isValid);
        }

        return null;
    }

    hasNoConnections(astNode) {
        const block = astNode.getSourceBlock();
        if (!block || !block.inputList) return true;
        return true;
    }

    hasSingleConnection(astNode) {
        const block = astNode.getSourceBlock();
        if (!block || !block.inputList) return true;
        return true;
    }

    hasSingleValueBlock(astNode) {
        const block = astNode.getSourceBlock();
        if (!block || !block.inputList) return false;

        if (block.inputList.length > 1) return false;

        for (const input of block.inputList) {
            if (
                input.connection &&
                input.connection.type === Blockly.ConnectionType.NEXT_STATEMENT
            ) {
                return false;
            }
        }

        return true;
    }

    hasStatementInputFromASTNode(astNode) {
        const block = astNode.getSourceBlock();
        if (!block || !block.inputList) return false;

        for (const input of block.inputList) {
            if (
                input.connection &&
                input.connection.type === Blockly.ConnectionType.NEXT_STATEMENT
            ) {
                return true;
            }
        }

        return false;
    }

    findClosestStackTopBlock(curNode) {
        const ws = curNode.getWorkspace ? curNode.getWorkspace() : Blockly.getMainWorkspace();
        if (!ws) return null;

        const wsCoord = curNode.getWsCoordinate ? curNode.getWsCoordinate() : null;
        if (!wsCoord) return null;

        const topBlocks = ws.getTopBlocks(true);
        if (!topBlocks || !topBlocks.length) return null;

        let closest = null;
        let bestD2 = Infinity; // squared distance

        for (const b of topBlocks) {
            const p = b.getRelativeToSurfaceXY();
            const dx = p.x - wsCoord.x;
            const dy = p.y - wsCoord.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                closest = b;
            }
        }

        return closest;
    }


    /**
     * Return the first editable field on a block, optionally preferring dropdown-like fields.
     * @param {Blockly.Block} block
     * @param {Object} [opts]
     * @param {boolean} [opts.preferDropdown=true]
     * @returns {?Object} A Blockly.Field or null if none found
     */
    _getFirstEditableField(block, { preferDropdown = true } = {}) {
        if (!block) return [];

        const editableFields = [];
        for (const input of block.inputList) {
            for (const field of input.fieldRow) {
                if (typeof field?.isCurrentlyEditable === 'function' && field.isCurrentlyEditable()) {
                    editableFields.push(field);
                }
            }
        }
        if (editableFields.length === 0) return null;

        if (preferDropdown) {
            const dropdown = editableFields.find(f => this._isDropdownLikeField(f));
            if (dropdown) return dropdown;
        }
        // fallback: first editable (text/number/etc.)
        return editableFields[0];
    }

    _isDropdownLikeField(field) {
        if (!field) return false;
        const hasOptions = typeof field?.getOptions === 'function';

        const isDropdown =
            (typeof Blockly.FieldDropdown !== 'undefined' && field instanceof Blockly.FieldDropdown) ||
            (typeof Blockly.FieldVariable !== 'undefined' && field instanceof Blockly.FieldVariable);

        return !!(hasOptions || isDropdown);
    }

    /**
     * Focus and open the first editable dropdown-like field on the current block.
     * - Works in navigation mode (not restricted to editMode).
     * @returns {?Blockly.ASTNode} The focused FIELD node or null if none found.
     */
    openDropdown() {
        const curNode = this.getCurNode?.();
        if (!curNode) return null;

        const block = curNode.getSourceBlock?.();
        if (!block) return null;

        // prefer editable dropdown-like fields on this block.
        const field = this._getFirstEditableField(block, { preferDropdown: true });
        if (!field || !this._isDropdownLikeField(field)) {
            return null; // no dropdown to open here
        }

        // focus the field node.
        const fieldNode = Blockly.ASTNode.createFieldNode(field);
        this.setCurNode(fieldNode);

        return fieldNode;
    }


    layerIn() {
        if (this.editMode) {
            this.editConnection = "LAYER_IN";
            return this.nestedConnection();
        }
        console.log("AC Cursor F: layer in");
        let curNode = this.getCurNode();
        if (!curNode) {
            return null;
        }

        if (curNode.getType() === Blockly.ASTNode.types.WORKSPACE) {
            if (this.lastStack) {
                this.setCurNode(this.lastStack);
                return this.lastStack;
            }
            let closest = this.findClosestStackTopBlock(curNode)
            if (closest) {
                const stackNode = Blockly.ASTNode.createStackNode(closest);
                this.setCurNode(stackNode);
                return stackNode;
            }
            return null;
        }

        let newNode = null;
        if (curNode.getType() === Blockly.ASTNode.types.STACK) {
            newNode = this.getDiagNode(curNode, this.isValidHorizontalNode.bind(this));
            this.setCurNode(newNode);
            return newNode;
        }

        const block = curNode.getSourceBlock();
        if (!block) return null;

        // find NEXT_STATEMENT input connections
        const stmtInputs = block.inputList?.filter(
               i => i.connection && i.connection.type === Blockly.ConnectionType.NEXT_STATEMENT) || [];
        if (stmtInputs.length) {
            for (const input of block.inputList) {
                const conn = input.connection;
                const target = conn?.targetBlock();
                if (conn && conn.type === Blockly.ConnectionType.NEXT_STATEMENT && target) {
                    const node = Blockly.ASTNode.createBlockNode(target);
                    if (this.isValidLayerNode(node)) {
                        this.setCurNode(node);
                        return node;
                    }
                }
            }
            return null;
        }

        // find INPUT_VALUE input connections on non-containers like set-variable
        if (!Util.isContainerBlock(block)) {
            for (const input of block.inputList) {
                const conn = input.connection;
                const target = conn?.targetBlock();
                if (conn && conn.type === Blockly.ConnectionType.INPUT_VALUE && target) {
                    const node = Blockly.ASTNode.createBlockNode(target);
                    if (this.isValidLayerNode(node)) {
                        this.setCurNode(node);
                        return node;
                    }
                }
            }
        }

        newNode = this.getLayerInNode(curNode, this.isValidLayerNode.bind(this));

        if (!newNode && !this.hasStatementInputFromASTNode(curNode)) {
            newNode = this.findFirstBlockInOrNext(curNode.in(), this.isValidHorizontalNode.bind(this));
        }

        if (newNode) {
            console.log("IN Node Final Type:" + newNode.getType());
            this.setCurNode(newNode);
            let sblock = newNode.getSourceBlock();
            console.log("In source block type:" + sblock.type);
        }

        return newNode;
    }

    getLayerOutNode(curNode, isValid) {
        console.log("call getOutNode, type=", curNode ? curNode.getType() : 'none')
        if (!curNode) {
            return null;
        }

        let newNode = curNode.out();
        console.log("call getOutNode next, type=", newNode ? newNode.getType() : 'none')

        if (isValid(newNode)) {
            return newNode;
        } else if (newNode) {
            return this.getLayerOutNode(newNode, isValid);
        }

        return null;
    }

    layerOut() {
        console.log("AC Cursor Q: layer out");
        if (this.editMode) {
            return null;
        }
        let curNode = this.getCurNode();
        if (!curNode) {
            return null;
        }

        let newNode = this.getLayerOutNode(curNode, this.isValidHorizontalNode.bind(this));

        if (newNode) {
            console.log("LAYER OUT Node Final Type:" + newNode.getType());
            this.setCurNode(newNode);
        }
        return newNode;

    }

    isValueInputConnection(node) {
        if (!node || node.getType() !== Blockly.ASTNode.types.INPUT) {
            return false;
        }
        const connection = node.getLocation();
        return connection.type === Blockly.ConnectionType.INPUT_VALUE;
    }

    hasValueInputFromASTNode(astNode) {
        const block = astNode.getSourceBlock();
        if (!block || !block.inputList) return false;

        for (const input of block.inputList) {
            if (
                input.connection &&
                input.connection.type === Blockly.ConnectionType.INPUT_VALUE
            ) {
                return true;
            }
        }

        return false;
    }

    isStatementInputConnection(node) {
        if (!node || node.getType() !== Blockly.ASTNode.types.INPUT) {
            return false;
        }
        const connection = node.getLocation();
        return connection.type === Blockly.ConnectionType.NEXT_STATEMENT;
    }

    hasFullParentBlock(curNode) {
        if (!curNode || !curNode.out()) {
            return false;
        }

        return this.hasStatementInputFromASTNode(curNode.out());
    }

    isOutputBlock(node) {
        let block = node.getSourceBlock();
        if (block && block.outputConnection) {
            return true;
        }
        return false
    }

    isVisuallyRightConnected(parentBlock, input) {
        const inputXY = input.connection.getOffsetInBlock();
        const blockWidth = parentBlock.getHeightWidth().width;

        return inputXY.x > (blockWidth * 0.9); // more lenient than center
    }


    isSemanticHorizontalRight(block, input) {
        const horizontalInputTypes = [
            'controls_if',
            'controls_repeat_ext',
            'controls_whileUntil',
            'variables_set',
            'math_change',
            'text_print'
            // add more blocks of similar types
        ];
        return horizontalInputTypes.includes(block.type) && input.connection;
    }

    /** A value block's filled value inputs, in order (a shadow holds the value too). */
    valueChildren(block) {
        return block.inputList
            .filter((input) => input.connection?.type === Blockly.ConnectionType.INPUT_VALUE && input.connection.targetBlock())
            .map((input) => input.connection.targetBlock());
    }

    /**
     * Where D, S, W or A go inside nested value blocks when the rules above find nothing: D into a value block's
     * first child, S and W between the children of a value block, A back to the block a value is plugged into.
     */
    valueFallback(curNode, key) {
        if (curNode?.getType() !== Blockly.ASTNode.types.BLOCK) return null;
        const block = curNode.getSourceBlock();
        const parent = block?.outputConnection?.targetBlock();
        let target = null;
        if (key === 'in' && block?.outputConnection) target = this.valueChildren(block)[0];
        if ((key === 'next' || key === 'prev') && parent?.outputConnection) {
            const siblings = this.valueChildren(parent);
            target = siblings[siblings.indexOf(block) + (key === 'next' ? 1 : -1)];
        }
        if (key === 'out') target = parent;
        return target ? Blockly.ASTNode.createBlockNode(target) : null;
    }

    in() {
        console.log("AC Cursor D: in");

        if (this.editMode) {
            this.editConnection = 'RIGHT';
            return this.rightConnection();
        }

        const curNode = this.getCurNode();
        if (!curNode ||
            curNode.getType() === Blockly.ASTNode.types.STACK ||
            curNode.getType() === Blockly.ASTNode.types.WORKSPACE) {
            return null;
        }

        const srcBlock = curNode.getSourceBlock();
        let newNode = null;

        if (srcBlock) {
            for (const input of srcBlock.inputList) {
                const isValueInput = input.connection && input.connection.type === Blockly.ConnectionType.INPUT_VALUE;
                if (isValueInput &&
                    (this.isSemanticHorizontalRight(srcBlock, input) || this.isVisuallyRightConnected(srcBlock, input))) {

                    const target = input.connection.targetBlock();
                    newNode = target
                        ? Blockly.ASTNode.createBlockNode(target)
                        : Blockly.ASTNode.createConnectionNode(input.connection);

                    if (this.isValidHorizontalNode(newNode)) {
                        this.setCurNode(newNode);
                        return newNode;
                    }
                }
            }
        }


        if (
            (this.hasStatementInputFromASTNode(curNode) || (this.hasSingleValueBlock(curNode) && !this.isOutputBlock(curNode)))
            && this.isValueInputConnection(curNode.in())) {
            newNode = this.outputConnectionNode(curNode, this.isValidHorizontalNode.bind(this));
            if (newNode) {
                this.setCurNode(newNode);
                return newNode;
            } else {
                return null;
            }
        }

        // Fallback: check for next node in the stack
        if (!this.hasStatementInputFromASTNode(curNode) && !this.hasFullParentBlock(curNode)) {
            newNode = this.getNextRightNode(curNode, this.isValidDNode.bind(this));
        }
        newNode = newNode || this.valueFallback(curNode, 'in');

        if (newNode) {
            console.log("IN Node Final Type:", newNode.getType());
            this.setCurNode(newNode);
            const sblock = newNode.getSourceBlock();
            console.log("In source block type:", sblock?.type);
        }

        return newNode;
    }


    findSibling(node) {
        if (!node) {
            return null;
        }
        console.log("start sibiling node: " + node.getType());
        return node.next();
    }

    getNextRightNode(curNode, isValid) {
        console.log("Get right node: " + curNode.getType());
        if (!curNode) {
            return null;
        }
        let newNode = curNode.next();

        if (newNode && newNode.getType() === ASTNode.types.INPUT) {
            newNode = newNode.in();
        }

        if (isValid(newNode)) {
            console.log("found next: ", newNode.getType())
            return newNode;
        } else if (newNode) {
            console.log("calling next", newNode.getType())
            return this.getNextRightNode(newNode, isValid);
        }

        let sibiling = this.findSibling(curNode.out());
        if (isValid(sibiling)) {
            console.log("found sibiling", sibiling.getType())
            return sibiling;
        } else if (sibiling) {
            console.log("calling sibiling", sibiling.getType())
            return this.getNextRightNode(sibiling, isValid);
        }
        return null;
    }

    getPrevNode(curNode, isValid) {
        console.log("call getPrevNode, type=", curNode ? curNode.getType() : 'none')
        if (!curNode) {
            return null;
        }

        let newNode = curNode.prev();
        console.log("call getPrevNode next, type=", newNode ? newNode.getType() : 'none')

        if (isValid(newNode)) {
            return newNode;
        } else if (newNode) {
            return this.getPrevNode(newNode, isValid);
        }

        return null;
    }

    prev() {
        console.log("AC Cursor W: prev");
        if (this.editMode) {
            this.editConnection = "TOP";
            return this.topConnection();
        }

        const curNode = this.getCurNode();
        if (!curNode) {
            return null;
        }

        let newNode = this.getPrevNode(curNode, this.isValidVerticalNode.bind(this)) || this.valueFallback(curNode, 'prev');

        if (newNode) {
            console.log("PREV Node Final Type:" + newNode.getType());
            this.setCurNode(newNode);
        }

        if (newNode && newNode.getType() === Blockly.ASTNode.types.STACK) {
            this.lastStack = newNode;
        }

        return newNode;
    }

    getNextLeftNode(curNode, isValid) {
        console.log("Get left node: " + curNode.getType());
        if (!curNode) {
            return null;
        }

        let newNode = curNode.prev();

        if (newNode && newNode.getType() === ASTNode.types.INPUT) {
            const innerNode = newNode.in();
            newNode = innerNode ? innerNode.next() : null;
        }

        if (isValid(newNode)) {
            console.log("found prev: ", newNode.getType())
            return newNode;
        } else if (newNode) {
            console.log("calling prev", newNode.getType())
            return this.getNextLeftNode(newNode, isValid);
        }

        let sibling = this.findPrevSibling(curNode.out());
        if (isValid(sibling)) {
            return sibling;
        } else if (sibling) {
            return this.getNextLeftNode(sibling, isValid);
        }
        return null;
    }

    findPrevSibling(node) {
        if (!node) {
            return null;
        }
        return node.prev();
    }

    isOutputConnection(node) {
        if (!node || node.getType() !== Blockly.ASTNode.types.OUTPUT) {
            return false;
        }
        const connection = node.getLocation();
        return connection.type === Blockly.ConnectionType.OUTPUT_VALUE;
    }

    getOutNode(curNode, isValid) {
        console.log("call getOutNode, type=", curNode ? curNode.getType() : 'none')
        if (!curNode) {
            return null;
        }

        let newNode = curNode.prev();
        console.log("call getOutNode prev, type=", newNode ? newNode.getType() : 'none');

        if (newNode && newNode.getType() === Blockly.ASTNode.types.OUTPUT) {
            newNode = newNode.out();
        }

        if (newNode && newNode.getType() === Blockly.ASTNode.types.INPUT) {
            newNode = newNode.prev();
        }

        if (!newNode) {
            newNode = curNode.out();
        }

        if (isValid(newNode)) {
            return newNode;
        } else if (newNode) {
            return this.getOutNode(newNode, isValid);
        }

        return null;
    }

    leftConnection() {
        if (!this.editingBlock) {
            return null;
        }

        const blk = this.editingBlock.getSourceBlock();
        const seq = this._buildInnerNodeSeq(blk);
        const curLoc = this.getCurNode()?.getLocation();
        const curIdx = seq.findIndex(n => n.getLocation() === curLoc);

        if (curIdx <= 1) {
            return null;
        }

        const newNode = seq[curIdx - 1];
        this.setCurNode(newNode);
        return newNode;
    }


    isOnlyConnectedChild(curNode) {
        const currentBlock = curNode.getSourceBlock?.();
        const parentConn = curNode.out();
        const parentBlock = parentConn?.getSourceBlock?.();

        if (!currentBlock || !parentBlock) return false;

        // Count all connected child blocks
        let connectedChildren = 0;
        for (const input of parentBlock.inputList) {
            const target = input.connection?.targetBlock();
            if (target) connectedChildren++;
        }

        return connectedChildren === 1;
    }

    isBlockLeftOf(blockA, blockB) {
        if (!blockA || !blockB) return false;

        const posA = blockA.getRelativeToSurfaceXY();
        const posB = blockB.getRelativeToSurfaceXY();

        const sizeA = blockA.getHeightWidth();
        const sizeB = blockB.getHeightWidth();

        const centerXA = posA.x + sizeA.width / 2;
        const centerXB = posB.x + sizeB.width / 2;

        console.log("Block A Center X:", centerXA, "Y:", posA.y);
        console.log("Block B Center X:", centerXB, "Y:", posB.y);

        return centerXA < centerXB;
    }


    out() {
        if (this.editMode) {
            let node = this.leftConnection();
            if (node) {
                this.editConnection = 'LEFT';
            }
            return node;
        }
        console.log("AC Cursor A: out");
        const curNode = this.getCurNode();
        if (!curNode) {
            return null;
        }

        console.log("current node type: " + curNode.getType());

        if (curNode.getType() === Blockly.ASTNode.types.STACK ||
            curNode.getType() === Blockly.ASTNode.types.WORKSPACE) {
            return null;
        }

        let newNode = null;

        if (this.isOnlyConnectedChild(curNode) && !Util.isContainerBlock(curNode.getSourceBlock())) {
            const parentConn = curNode.out();
            const parentBlock = parentConn?.getSourceBlock?.();
            const currentBlock = curNode.getSourceBlock?.();

            if (parentBlock && currentBlock) {
                const parentXY = parentBlock.getRelativeToSurfaceXY();
                const childXY = currentBlock.getRelativeToSurfaceXY();

                // child is visually right of parent
                if (childXY.x > parentXY.x) {
                    newNode = Blockly.ASTNode.createBlockNode(parentBlock);
                    if (this.isValidDNode(newNode)) {
                        this.setCurNode(newNode);
                        return newNode;
                    }
                }
            }
        }

        if (!newNode && (this.isOutputConnection(curNode) || this.isOutputConnection(curNode.prev()))) {
            newNode = this.getOutNode(curNode, this.isValidHorizontalNode.bind(this));
            if (!this.hasStatementInputFromASTNode(newNode) && !this.hasSingleValueBlock(curNode)) {
                newNode = this.valueFallback(curNode, 'out');
                if (newNode) this.setCurNode(newNode);
                return newNode;
            }
        }

        if (!this.hasStatementInputFromASTNode(curNode) && !this.hasFullParentBlock(curNode)) {
            newNode = this.getNextLeftNode(curNode, this.isValidDNode.bind(this));
            if (newNode && !this.isBlockLeftOf(newNode.getSourceBlock?.(), curNode.getSourceBlock?.())) {
                newNode = null;
            }
        }

        newNode = newNode || this.valueFallback(curNode, 'out');
        if (newNode) {
            console.log("PREV Node Final Type:" + newNode.getType());
            this.setCurNode(newNode);
        }

        return newNode;
    }

    scrollBoundsIntoView(bounds, workspace) {
        if (Blockly.Gesture.inProgress()) {
            // This can cause jumps during a drag and it only suited for keyboard nav.
            return;
        }
        const scale = workspace.getScale();

        const rawViewport = workspace.getMetricsManager().getViewMetrics(true);
        const viewport = new Blockly.utils.Rect(
            rawViewport.top,
            rawViewport.top + rawViewport.height,
            rawViewport.left,
            rawViewport.left + rawViewport.width,
        );

        if (
            bounds.left >= viewport.left &&
            bounds.top >= viewport.top &&
            bounds.right <= viewport.right &&
            bounds.bottom <= viewport.bottom
        ) {
            // Do nothing if the block is fully inside the viewport.
            return;
        }

        // Add some padding to the bounds so the element is scrolled comfortably
        // into view.
        bounds = bounds.clone();
        bounds.top -= 10;
        bounds.bottom += 10;
        bounds.left -= 10;
        bounds.right += 10;

        let deltaX = 0;
        let deltaY = 0;

        if (bounds.left < viewport.left) {
            deltaX = viewport.left - bounds.left;
        } else if (bounds.right > viewport.right) {
            deltaX = viewport.right - bounds.right;
        }

        if (bounds.top < viewport.top) {
            deltaY = viewport.top - bounds.top;
        } else if (bounds.bottom > viewport.bottom) {
            deltaY = viewport.bottom - bounds.bottom;
        }

        deltaX *= scale;
        deltaY *= scale;
        workspace.scroll(workspace.scrollX + deltaX, workspace.scrollY + deltaY);
    }

    setCurNode(newNode) {
        this.updateSelectionFromNode(newNode);

        // track past node id for undo action
        this.pastNode = this.curNode || null;
        this.pastNodeBlockId = this.pastNode?.getSourceBlock?.()?.id || null;

        super.setCurNode(newNode);

        // scroll cursor into current block view
        if (!this.shouldSuppressScroll &&
             newNode && newNode.getType() === Blockly.ASTNode.types.BLOCK) {
            const block = newNode.getLocation();
            this.scrollBoundsIntoView(
                block.getBoundingRectangleWithoutChildren(),
                block.workspace,
            );
        }
        // reset scroll
        this.shouldSuppressScroll = false;
    }


    updateSelectionFromNode(newNode) {
        if (newNode && newNode.getType() === Blockly.ASTNode.types.BLOCK) {
            if (Blockly.common.getSelected() !== newNode.getLocation()) {
                Blockly.Events.disable();
                Blockly.common.setSelected(newNode.getLocation());
                Blockly.Events.enable();
            }
        } else {
            if (Blockly.common.getSelected()) {
                Blockly.Events.disable();
                Blockly.common.setSelected(null);
                Blockly.Events.enable();
            }
        }
    }


    drawMarker(oldNode, curNode, realDrawer) {
        // if previous selection is connection the unhighlight
        if (oldNode && oldNode.isConnection && oldNode.isConnection()) {
            const oldConn = oldNode.getLocation();
            oldConn.unhighlight();
        }

        // if connection highlight corner only
        if (curNode && curNode.isConnection && curNode.isConnection()) {
            realDrawer.hide();
            curNode.getLocation().highlight(true);
            return;
        }

        // unselect old selection
        if (oldNode && (oldNode.getType() === Blockly.ASTNode.types.BLOCK ||
            oldNode.getType() === Blockly.ASTNode.types.STACK)) {
            const block = oldNode.getLocation();
            if (!block.isShadow()) {
                console.log("not shadow select");
                // Selection should already be in sync.
            } else {
                console.log("remove select");
                block.removeSelect();
            }
        }

        const curNodeType = curNode ? curNode.getType() : null;
        // delegate to default drawer if non-block
        if (curNodeType !== Blockly.ASTNode.types.BLOCK) {
            console.log("real drawer called");
            realDrawer.draw(oldNode, curNode);
            return;
        }

        // hide any visible marker SVG and instead do some manual rendering
        realDrawer.hide();

        if (curNode && curNodeType === Blockly.ASTNode.types.BLOCK) {
            const block = curNode.getLocation();
            if (!block.isShadow()) {
                // Selection should already be in sync.
            } else {
                block.addSelect();
                block.getParent()?.removeSelect();
            }
        }

        if (realDrawer && realDrawer.fireMarkerEvent) {
            realDrawer.fireMarkerEvent(oldNode, curNode);
        }
    }

    setDrawer(drawer) {
        const self = this;

        const altDraw = function (oldNode, curNode) {
            // Call drawMarker with the preserved context and raw drawer
            self.drawMarker(oldNode, curNode, drawer);
        };

        const proxyDrawer = new Proxy(drawer, {
            get: function (target, prop) {
                if (prop === 'draw') {
                    return altDraw;
                }
                return target[prop];
            }
        });

        super.setDrawer(proxyDrawer);
    }

    // simulate key move without side effect
    _simulateKeyPress(fn) {
        // snapshot mutable fields we might accidentally touch
        const snap = {
            curNode: this.getCurNode ? this.getCurNode() : null,
            lastStack: this.lastStack,
            editConnection: this.editConnection,
            shouldSuppressScroll: this.shouldSuppressScroll,
            editingBlock: this.editingBlock,
            editMode: this.editMode,
            pastNode: this.pastNode,
            pastNodeBlockId: this.pastNodeBlockId,
        };

        const origSetCurNode = this.setCurNode;
        try {
            // prevent visual/selection/scroll mutations during prediction
            this.setCurNode = function noop() {};
            this.shouldSuppressScroll = true;
            const predicted = fn.call(this) || null;
            return predicted;
        } catch (e) {
            console.error('AccessibleCursor._simulateKeyPress error:', e);
            return null;
        } finally {
            // restore state
            this.setCurNode = origSetCurNode;
            this.lastStack = snap.lastStack;
            this.editConnection = snap.editConnection;
            this.shouldSuppressScroll = snap.shouldSuppressScroll;
            this.editingBlock = snap.editingBlock;
            this.editMode = snap.editMode;
            this.pastNode = snap.pastNode;
            this.pastNodeBlockId = snap.pastNodeBlockId;
            // curNode never changed because setCurNode was a no-op.
        }
    }

    /**
     * Predict the node that would be focused if a nav key is pressed.
     * @param {'W'|'A'|'S'|'D'|'F'|'Q'} dir
     * @returns {?Blockly.ASTNode}
     */
    predictNavigableBlock(dir) {
        switch (dir) {
            case 'W': return this._simulateKeyPress(this.prev);
            case 'S': return this._simulateKeyPress(this.next);
            case 'D': return this._simulateKeyPress(this.in);
            case 'A': return this._simulateKeyPress(this.out);
            case 'F': return this._simulateKeyPress(this.layerIn);
            case 'Q': return this._simulateKeyPress(this.layerOut);
            default:  return null;
        }
    }
}


export const registrationType = Blockly.registry.Type.CURSOR;
export const registrationName = 'AccessibleCursor';

Blockly.registry.register(registrationType, registrationName, AccessibleCursor);

export const pluginInfo = {
    [registrationType]: registrationName,
};
