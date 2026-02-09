export class InputBuilder {
    /**
     * @param {!Blockly.WorkspaceSvg} workspace
     * @param {Object=} options
     * @param {boolean=} options.includeXML           Default true
     * @param {boolean=} options.includeVariables     Default true
     * @param {boolean=} options.includeBlocks        Default true
     * @param {boolean=} options.includeTypeCatalog   Default true
     * @param {number=}  options.maxHops              Graph radius from focus when trimming blocks (0=focus only). Default 2
     * @param {boolean=} options.trimBlocks           If true, include only blocks within maxHops of focus. Default true
     * @param {(ws:Blockly.WorkspaceSvg)=>string[]=} options.typeCatalogFn Optional custom source of allowed block types
     */
    constructor(workspace, options = {}) {
        if (!workspace) throw new Error("RequestBuilder: workspace is required");
        this.ws = workspace;
        this.opts = {
            includeXML: options.includeXML !== false,
            includeVariables: options.includeVariables !== false,
            includeBlocks: options.includeBlocks !== false,
            includeTypeCatalog: options.includeTypeCatalog !== false,
            includeAllowedTypeCatalog: options.includeAllowedTypeCatalog !== false,
            maxHops: Number.isFinite(options.maxHops) ? options.maxHops : 2,
            trimBlocks: options.trimBlocks !== false, // default true
            typeCatalogFn: options.typeCatalogFn || null
        };
    }

    // -------------------- Public APIs --------------------

    /** Build a complete request payload from an existing INPUT (cursor/workspace) plus mode. */
    buildFromInput(mode, input) {
        RequestBuilder.assertMode(mode);
        if (!input || typeof input !== "object") throw new Error("RequestBuilder.buildFromInput requires an input object");

        const cursor = input.cursor ?? this._cursorFromRuntime();
        const wsPart = this._augmentWorkspace(input.workspace || {} /* partial */ , cursor, mode);

        return { mode, cursor, workspace: wsPart };
    }

    /** Build from current cursor (reads this.ws cursor). */
    buildFromCursor(mode) {
        InputBuilder.assertMode(mode);
        const cursor = this._cursorFromRuntime();
        const wsPart = this._augmentWorkspace({}, cursor, mode);
        return { mode, cursor, workspace: wsPart };
    }

    /** Build for a specific block focus (R1). */
    buildForBlock(mode, blockId) {
        InputBuilder.assertMode(mode);
        const cursor = { blockId: blockId ?? null, connection: null };
        const wsPart = this._augmentWorkspace({}, cursor, mode);
        return { mode, cursor, workspace: wsPart };
    }

    /** Build for an explicit connection focus (R2). */
    buildForConnection(mode, connection) {
        InputBuilder.assertMode(mode);
        const cursor = {
            blockId: null,
            connection: connection ? {
                parentBlockId: connection.parentBlockId ?? null,
                kind: connection.kind,
                inputName: connection.inputName ?? null
            } : null
        };
        const wsPart = this._augmentWorkspace({}, cursor, mode);
        return { mode, cursor, workspace: wsPart };
    }

    /**
     * Build a lightweight context summary for intent classification.
     * Returns summary info about workspace without full block details.
     * @returns {Object} Context summary
     */
    buildContextSummary() {
        const cursor = this._cursorFromRuntime();
        const blocks = this.ws.getAllBlocks(false);
        const variables = this._getVariables();

        // Get block type counts
        const typeCounts = {};
        for (const b of blocks) {
            typeCounts[b.type] = (typeCounts[b.type] || 0) + 1;
        }

        // Get focused block info if available
        let focusedBlock = null;
        if (cursor.blockId) {
            const block = this.ws.getBlockById(cursor.blockId);
            if (block) {
                focusedBlock = {
                    id: block.id,
                    type: block.type,
                    hasError: block.hasError?.() || false
                };
            }
        }

        // Get focused connection info if available
        let focusedConnection = null;
        if (cursor.connection) {
            focusedConnection = {
                parentBlockId: cursor.connection.parentBlockId,
                kind: cursor.connection.kind,
                inputName: cursor.connection.inputName,
                isEmpty: !this._getConnectedBlockId(cursor.connection)
            };
        }

        return {
            totalBlocks: blocks.length,
            blockTypes: Object.keys(typeCounts),
            typeCounts,
            variableCount: variables.length,
            variableNames: variables.map(v => v.name),
            focusedBlock,
            focusedConnection,
            hasBlocks: blocks.length > 0
        };
    }

    /**
     * Get the connected block ID for a connection schema
     * @private
     */
    _getConnectedBlockId(connSchema) {
        if (!connSchema?.parentBlockId) return null;
        const parentBlock = this.ws.getBlockById(connSchema.parentBlockId);
        if (!parentBlock) return null;

        // Find the input connection
        for (const input of parentBlock.inputList || []) {
            if (input.name === connSchema.inputName && input.connection) {
                const target = input.connection.targetBlock?.();
                return target?.id || null;
            }
        }
        return null;
    }

    // -------------------- Internals --------------------

    /** Fallback cursor grabber from live Blockly runtime. */
    _cursorFromRuntime() {
        const cursorApi = this.ws.getCursor?.();
        const curNode = cursorApi?.getCurNode?.() || null;
        const empty = { scope: 'WORKSPACE', blockId: null, connection: null };
        if (!curNode) return empty;

        const T = Blockly.ASTNode?.types || {};
        const type = curNode.getType?.();

        if (type === T.STACK) {
            const blk = curNode.getSourceBlock?.() || curNode.getLocation?.();
            return { scope: 'STACK', blockId: blk?.id ?? null, connection: null };
        }

        if (type === T.BLOCK) {
            const blk = curNode.getSourceBlock?.() || curNode.getLocation?.();
            return { scope: 'BLOCK', blockId: blk?.id ?? null, connection: null };
        }

        if (type === T.FIELD) {
            const owner = curNode.getLocation?.()?.getSourceBlock?.();
            return { scope: 'BLOCK', blockId: owner?.id ?? null, connection: null };
        }

        if (curNode.isConnection?.()) {
            const conn = curNode.getLocation?.();
            return { scope: 'CONNECTION', blockId: null, connection: this._connectionToSchema(conn) };
        }

        if (type === T.WORKSPACE) {
            return { scope: 'WORKSPACE', blockId: null, connection: null };
        }

        return empty;
    }

    /** Convert a Blockly.Connection → schema connection. */
    _connectionToSchema(conn) {
        if (!conn) return null;
        const CT = Blockly.ConnectionType || Blockly;
        let kind = null;
        switch (conn.type) {
            case CT.INPUT_VALUE: kind = "INPUT_VALUE"; break;
            case CT.OUTPUT_VALUE: kind = "OUTPUT_VALUE"; break;
            case CT.NEXT_STATEMENT: kind = "NEXT_STATEMENT"; break;
            case CT.PREVIOUS_STATEMENT: kind = "PREVIOUS_STATEMENT"; break;
            default: kind = "INPUT_VALUE"; break;
        }
        const parentBlock = conn.getSourceBlock?.() || null;
        let inputName = null;
        if (kind === "INPUT_VALUE" && parentBlock?.inputList) {
            for (const input of parentBlock.inputList) {
                if (input.connection === conn) { inputName = input.name || null; break; }
            }
        }
        return { parentBlockId: parentBlock?.id ?? null, kind, inputName };
    }

    /**
     * Ensure workspace section is populated per options. Optionally trims blocks to a graph around focus.
     * @param {Object} partialWs
     * @param {{blockId:string|null,connection:Object|null}} cursor
     */
    _augmentWorkspace(partialWs, cursor, mode) {
        const out = { ...partialWs };

        if (this.opts.includeXML && !out.xml) out.xml = this._workspaceToXML();
        if (this.opts.includeVariables && !out.variables) out.variables = this._getVariables();

        // Blocks (serialized minimal descriptors)
        if (this.opts.includeBlocks && !out.blocks) {
            const focusIds = this._seedIdsFromCursor(cursor);
            const idsToInclude = this.opts.trimBlocks
                ? this._graphIdsWithinHops(focusIds, this.opts.maxHops)
                : this._allBlockIds();
            out.blocks = idsToInclude.map(id => this._serializeBlock(id)).filter(Boolean);
        }

        // Type catalog
        // if (this.opts.includeTypeCatalog && !out.typeCatalog) {
        //     out.typeCatalog = this._deriveTypeCatalog(out.blocks);
        // }

        // Allowed catalog
        if (this.opts.includeAllowedTypeCatalog && ['EDIT_GUIDE', 'DEBUG'].includes(mode)) {
            out.allowedTypeCatalog = this._allowedTypeCatalog();
        }

        // console.log("GREAT: ", JSON.stringify(out)) // TODO: RUBEL: print json here if needed
        return out;
    }

    /** Serialize workspace → XML text with xmlns. */
    _workspaceToXML() {
        const dom = Blockly.Xml.workspaceToDom(this.ws);
        if (!dom.getAttribute("xmlns")) dom.setAttribute("xmlns", "https://developers.google.com/blockly/xml");
        return Blockly.Xml.domToText(dom);
    }

    /** Gather variables as [{id,name}]. */
    _getVariables() {
        const vars = typeof this.ws.getAllVariables === "function" ? this.ws.getAllVariables() : [];
        return vars.map(v => ({ id: v.getId ? v.getId() : v.id, name: v.name }));
    }

    /** Block IDs to seed the trim graph based on cursor. */
    _seedIdsFromCursor(cursor) {
        const ids = new Set();
        if (cursor?.blockId) ids.add(cursor.blockId);
        if (cursor?.connection?.parentBlockId) ids.add(cursor.connection.parentBlockId);
        return [...ids];
    }

    /** All block IDs in workspace. */
    _allBlockIds() {
        return this.ws.getAllBlocks(false).map(b => b.id);
    }

    /** BFS within N hops across connections/next/previous. */
    _graphIdsWithinHops(seedIds, maxHops) {
        const seen = new Set();
        const q = [...(seedIds.length ? seedIds : this._topLevelIds())];
        let hops = 0;
        while (q.length && hops <= maxHops) {
            const breadth = q.splice(0, q.length);
            for (const id of breadth) {
                if (seen.has(id)) continue;
                seen.add(id);
                const neighbors = this._neighborIds(id);
                for (const n of neighbors) if (!seen.has(n)) q.push(n);
            }
            hops += 1;
        }
        return [...seen];
    }

    _topLevelIds() {
        return this.ws.getTopBlocks(true).map(b => b.id);
    }

    /** Find neighbor block IDs via inputs, previous/next, output and connected targets. */
    _neighborIds(id) {
        const b = this.ws.getBlockById(id);
        if (!b) return [];
        const out = new Set();

        // previous/next chain
        if (b.previousConnection?.targetBlock()) out.add(b.previousConnection.targetBlock().id);
        if (b.nextConnection?.targetBlock()) out.add(b.nextConnection.targetBlock().id);

        // output parent
        if (b.outputConnection?.targetBlock()) out.add(b.outputConnection.targetBlock().id);

        // inputs to children
        for (const input of b.inputList || []) {
            const child = input.connection?.targetBlock?.();
            if (child) out.add(child.id);
        }

        return [...out];
    }

    /** Minimal serializer matching the contract. */
    _serializeBlock(id) {
        const b = this.ws.getBlockById(id);
        if (!b) return null;

        const fields = {};
        // Stable iteration: fieldRow is nested; use getFieldValue for named fields
        for (const input of b.inputList || []) {
            for (const field of input.fieldRow || []) {
                const name = field?.name;
                if (name && typeof b.getFieldValue === "function") {
                    const val = b.getFieldValue(name);
                    if (val != null) fields[name] = String(val);
                }
            }
        }

        // Some blocks have top-level fields not in inputs; fall back to b.inputList scan already done above.

        const inputs = [];
        for (const input of b.inputList || []) {
            const name = input.name || "";
            const kind = this._inputKindToString(input.type);
            const child = input.connection?.targetBlock?.();
            inputs.push({ name, kind, connectedBlockId: child ? child.id : null });
        }

        const next = b.nextConnection?.targetBlock?.()?.id ?? null;
        const previous = b.previousConnection?.targetBlock?.()?.id ?? null;
        const output = b.outputConnection ? b.id : null; // OUTPUT socket represented by owning block id

        return { id: b.id, type: b.type, fields, inputs, next, previous, output };
    }

    _inputKindToString(inputType) {
        const IT = Blockly.inputTypes || Blockly; // compat across versions
        switch (inputType) {
            case IT.VALUE: return "INPUT_VALUE";
            case IT.STATEMENT: return "NEXT_STATEMENT"; // consumer side knows this is the container for a chain
            case IT.DUMMY: return "INPUT_VALUE"; // no-connection, map to value for neutrality
            default: return "INPUT_VALUE";
        }
    }

    /** Derive type catalog from blocks/types available or custom fn. */
    _deriveTypeCatalog(blocks) {
        if (this.opts.typeCatalogFn) {
            const list = this.opts.typeCatalogFn(this.ws) || [];
            return [...new Set(list)].sort();
        }
        if (Array.isArray(blocks) && blocks.length) {
            return [...new Set(blocks.map(b => b.type))].sort();
        }
        // Fallback to all block types in workspace
        return [...new Set(this.ws.getAllBlocks(false).map(b => b.type))].sort();
    }

    _allowedTypeCatalog() {
        // precomputed at init time
        if (Array.isArray(this.ws?.allowedTypeCatalog) && this.ws.allowedTypeCatalog.length) {
            return [...new Set(this.ws.allowedTypeCatalog)].sort();
        }

        // Fallback: all block types currently on the workspace
        return [...new Set(this.ws.getAllBlocks(false).map(b => b.type))].sort();
    }


    // -------------------- Static helpers --------------------

    /** @param {"COMPREHEND"|"EDIT_GUIDE"|"DEBUG"} mode */
    static assertMode(mode) {
        const ok = mode === "COMPREHEND" || mode === "EDIT_GUIDE" || mode === "DEBUG";
        if (!ok) throw new Error(`Invalid mode: ${mode}`);
    }
}

/*
Example usage:

import { RequestBuilder } from "./RequestBuilder.js";

const rb = new RequestBuilder(Blockly.getMainWorkspace(), {
  includeXML: true,
  includeVariables: true,
  includeBlocks: true,
  includeTypeCatalog: true,
  trimBlocks: true,
  maxHops: 2
});

// From live cursor (R1 or R3 depending on mode)
const req1 = rb.buildFromCursor("COMPREHEND");

// For an explicit connection (R2)
const req2 = rb.buildForConnection("EDIT_GUIDE", {
  parentBlockId: "if1",
  kind: "INPUT_VALUE",
  inputName: "IF0"
});

// If you already built {cursor,workspace} with your InputProcessor
const already = someInputProcessor.buildFromCursor();
const req3 = rb.buildFromInput("DEBUG", already);
*/
