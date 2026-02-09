export class AgentActor {
    /**
     * @param {!Blockly.WorkspaceSvg} workspace
     * @param {{
     *   replaceExistingChild?: boolean,  // allow replacing an already-connected child on a target socket
     *   trackIdempotency?: boolean,      // remember applied idempotencyKeys
     *   defaultGroupPrefix?: string,     // undo group prefix
     *   allowDelete?: boolean,           // gate deleteBlock op
     *   recordUndo?: boolean             // pass through to block mutations (default true)
     * }=} options
     */
    constructor(workspace, options = {}) {
        if (!workspace) throw new Error("workspace is required");
        this.ws = workspace;
        this.opts = {
            replaceExistingChild: false,
            trackIdempotency: true,
            defaultGroupPrefix: "ai-patch",
            allowDelete: true,
            recordUndo: true,
            ...options,
        };

        // Track applied patches (per workspace).
        if (!this.ws.__appliedPatchKeys) this.ws.__appliedPatchKeys = new Set();

        /** Allowed patch connection kinds (for parentConn/childConn). */
        this._patchKinds = new Set(["INPUT", "NEXT", "PREVIOUS", "OUTPUT"]);

        /** Op handlers (extend via registerOp if needed). */
        this.handlers = Object.freeze({
            createBlock: this._opCreateBlock.bind(this),
            connect: this._opConnect.bind(this),
            disconnect: this._opDisconnect.bind(this),
            deleteBlock: this._opDeleteBlock.bind(this),
            setField: this._opSetField.bind(this),
            moveBlock: this._opMoveBlock.bind(this),
        });
    }

    // ========= Public API ===================================================

    /**
     * Apply one patch object with operations[] (current schema).
     * @param {{ idempotencyKey?: string, operations: Array<Object> }} patch
     * @returns {{applied: boolean, createdIds: string[], errors: string[]}}
     */
    applyPatch(patch) {
        const errors = [];
        const createdIds = [];
        let opsSucceeded = 0;

        if (!patch || !Array.isArray(patch.operations) || patch.operations.length === 0) {
            return { applied: false, opsSucceeded: 0, opsTotal: 0, createdIds, errors: ["Invalid or empty patch"] };
        }

        const opsTotal = patch.operations.length;

        // Idempotency: skip if already applied, unless force flag is set.
        if (this.opts.trackIdempotency && patch.idempotencyKey && !patch.force) {
            if (this.ws.__appliedPatchKeys.has(patch.idempotencyKey)) {
                return { applied: true, opsSucceeded: 0, opsTotal, createdIds, errors, skipped: true };
            }
        }

        const group = `${this.opts.defaultGroupPrefix}-${patch.idempotencyKey || Date.now()}`;
        Blockly.Events.setGroup(group);
        try {
            for (const op of patch.operations) {
                const fn = op && this.handlers[op.op];
                if (!fn) {
                    errors.push(`Unknown op: ${op?.op}`);
                    break;
                }
                try {
                    const res = fn(op);
                    opsSucceeded++;
                    if (res?.createdId) createdIds.push(res.createdId);
                } catch (e) {
                    errors.push(`${op.op} failed: ${e?.message || String(e)}`);
                    break; // stop on first hard failure
                }
            }
            // Record idempotency if at least one op succeeded
            if (opsSucceeded > 0 && this.opts.trackIdempotency && patch.idempotencyKey) {
                this.ws.__appliedPatchKeys.add(patch.idempotencyKey);
            }
        } finally {
            Blockly.Events.setGroup(false);
        }

        return { applied: opsSucceeded > 0, opsSucceeded, opsTotal, createdIds, errors };
    }

    /** Convenience helpers that look into your LLM response shape */

    /** Apply first step (EDIT_GUIDE flow). */
    applyFirstStep(llm) {
        const patch = llm?.editPlan?.steps?.[0]?.patch;
        if (!patch) return { applied: false, createdIds: [], errors: ["No edit steps found"] };
        return this.applyPatch(patch);
    }

    /** Apply step by exact title. */
    applyStepByTitle(llm, title) {
        const step = (llm?.editPlan?.steps || []).find(s => s.title === title);
        if (!step?.patch) return { applied: false, createdIds: [], errors: [`Step "${title}" not found`] };
        return this.applyPatch(step.patch);
    }

    applyFirstProposedFix(llm) {
        const fix = llm?.diagnostics?.proposedFixes?.[0];
        if (!fix?.patch) {
            return { applied: false, createdIds: [], errors: ["No proposed fixes found"] };
        }
        return this.applyPatch(fix.patch);
    }

    /** Apply all proposed fixes (DEBUG flow), stops on first failure. */
    applyAllProposedFixes(llm) {
        const fixes = llm?.diagnostics?.proposedFixes || [];
        if (!Array.isArray(fixes) || fixes.length === 0) {
            return { applied: false, createdIds: [], errors: ["No proposed fixes found"] };
        }
        const createdIds = [];
        for (let i = 0; i < fixes.length; i++) {
            const res = this.applyPatch(fixes[i]?.patch);
            createdIds.push(...(res.createdIds || []));
            if (!res.applied) {
                return { applied: false, createdIds, errors: [`Fix ${i} failed: ${res.errors?.[0] || "Unknown error"}`] };
            }
        }
        return { applied: true, createdIds, errors: [] };
    }

    /**
     * Optional quick shape check for the parts we rely on.
     * @param {Object} resp - LLM response object
     * @param {string} [mode] - Optional mode to validate against ('COMPREHEND', 'EDIT_GUIDE', 'DEBUG')
     * @returns {{ok: boolean, reason?: string}}
     */
    static quickValidateResponse(resp, mode) {
        if (typeof resp !== "object" || !resp) return { ok: false, reason: "Response must be an object" };

        // Mode-specific validation
        if (mode === 'EDIT_GUIDE') {
            if (!resp.editPlan || !Array.isArray(resp.editPlan.steps)) {
                return { ok: false, reason: "editPlan.steps must be an array" };
            }
        } else if (mode === 'DEBUG') {
            if (!resp.diagnostics) {
                return { ok: false, reason: "diagnostics must be an object" };
            }
            if (!Array.isArray(resp.diagnostics.issues)) {
                return { ok: false, reason: "diagnostics.issues must be an array" };
            }
            if (!Array.isArray(resp.diagnostics.proposedFixes)) {
                return { ok: false, reason: "diagnostics.proposedFixes must be an array" };
            }
        } else if (mode === 'COMPREHEND') {
            if (!resp.comprehension || typeof resp.comprehension.summary !== 'string') {
                return { ok: false, reason: "comprehension.summary must be a string" };
            }
        }

        // Generic validation (if no mode specified, check for at least one valid response shape)
        if (!mode) {
            const hasEditPlan = resp.editPlan && Array.isArray(resp.editPlan.steps);
            const hasDiagnostics = resp.diagnostics && Array.isArray(resp.diagnostics.issues);
            const hasComprehension = resp.comprehension && typeof resp.comprehension.summary === 'string';

            if (!hasEditPlan && !hasDiagnostics && !hasComprehension) {
                return { ok: false, reason: "Response must have editPlan.steps, diagnostics.issues, or comprehension.summary" };
            }
        }

        return { ok: true };
    }

    /** Extend/override a custom operation. */
    registerOp(opName, handler) {
        this.handlers = { ...this.handlers, [opName]: handler };
    }

    // ========= Internals: Blocks, Fields, Connections ======================

    _getBlock(id, required = true) {
        const b = id ? this.ws.getBlockById(id) : null;
        if (!b && required) throw new Error(`Block not found: ${id}`);
        return b || null;
    }

    _setFields(block, fields = {}) {
        for (const [name, value] of Object.entries(fields)) {
            block.setFieldValue(String(value), name); // Blockly expects string inputs for fields
        }
    }

    /**
     * Resolve a patch connection descriptor:
     * { blockId: string, kind: "INPUT"|"NEXT"|"PREVIOUS"|"OUTPUT", inputName?: string|null }
     */
    _connFromDesc(desc) {
        if (!desc || !desc.blockId || !desc.kind) throw new Error("Connection desc missing blockId/kind");
        if (!this._patchKinds.has(desc.kind)) throw new Error(`Invalid connection kind: ${desc.kind}`);

        const blk = this._getBlock(desc.blockId);
        switch (desc.kind) {
            case "INPUT": {
                const name = desc.inputName || null;
                if (!name) throw new Error(`INPUT requires inputName for ${desc.blockId}`);
                const inp = blk.getInput(name);
                if (!inp?.connection) throw new Error(`Input ${name} has no connection on ${desc.blockId}`);
                return inp.connection;
            }
            case "NEXT":
                if (!blk.nextConnection) throw new Error(`${desc.blockId} has no NEXT`);
                return blk.nextConnection;
            case "PREVIOUS":
                if (!blk.previousConnection) throw new Error(`${desc.blockId} has no PREVIOUS`);
                return blk.previousConnection;
            case "OUTPUT":
                if (!blk.outputConnection) throw new Error(`${desc.blockId} has no OUTPUT`);
                return blk.outputConnection;
            default:
                throw new Error(`Unknown connection kind: ${desc.kind}`);
        }
    }

    _disconnectChild(superiorConn, { dispose = false } = {}) {
        if (!superiorConn?.isConnected?.()) return;
        const childConn = superiorConn.targetConnection || null;
        const childBlock = childConn?.getSourceBlock?.() || null;

        superiorConn.disconnect();

        if (childBlock && dispose) {
            childBlock.dispose(true);
        } else if (childConn && typeof childConn.bumpAwayFrom === "function") {
            try { childConn.bumpAwayFrom(superiorConn); } catch (_) {}
        }
    }

    // ========= Operation handlers ==========================================

    /** createBlock: { blockType, targetBlockId, fields?, position?{x,y} } */
    _opCreateBlock(op) {
        const { blockType, targetBlockId, fields, position } = op;
        if (!blockType || !targetBlockId) throw new Error("createBlock needs blockType and targetBlockId");

        // Idempotent create/update
        let block = this.ws.getBlockById(targetBlockId);
        if (!block) {
            block = this.ws.newBlock(blockType, targetBlockId);
            block.initSvg();
            if (fields) this._setFields(block, fields);
            if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
                block.moveTo(new Blockly.utils.Coordinate(position.x, position.y));
            }
            block.render();
            if (typeof block.setConnectionTracking === "function") block.setConnectionTracking(true);
            return { createdId: targetBlockId };
        }

        // Already exists: update fields/pos if provided
        if (fields) this._setFields(block, fields);
        if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
            block.moveTo(new Blockly.utils.Coordinate(position.x, position.y));
        }
        if (!block.rendered) block.render();
        return {};
    }

    /**
     * connect: {
     *   parentConn: { blockId, kind:"INPUT"|"NEXT"|"PREVIOUS"|"OUTPUT", inputName? },
     *   childConn:  { blockId, kind:"OUTPUT"|"PREVIOUS"|"NEXT"|"INPUT", inputName? }
     * }
     */
    _opConnect(op) {
        const parentConn = this._connFromDesc(op.parentConn);
        const childConn  = this._connFromDesc(op.childConn);

        // Decide superior/inferior using Blockly's connection API.
        const pSup = !!parentConn.isSuperior && parentConn.isSuperior();
        const cSup = !!childConn.isSuperior && childConn.isSuperior();
        const superior = pSup && !cSup ? parentConn : cSup && !pSup ? childConn : parentConn;
        const inferior = superior === parentConn ? childConn : parentConn;

        // Target already has child?
        if (superior.isConnected?.()) {
            if (this.opts.replaceExistingChild) {
                this._disconnectChild(superior, { dispose: false });
            } else {
                if (superior.targetConnection === inferior) return; // already correct (idempotent)
                return; // respect minimality; keep existing
            }
        }

        // If inferior attached elsewhere, detach first.
        if (inferior.isConnected?.()) {
            try { inferior.disconnect(); } catch (_) {}
        }

        // Let Blockly enforce type compatibility.
        superior.connect(inferior);
    }

    /**
     * disconnect: { parentConn? | childConn? }
     * (Only current scheme; no legacy shapes supported.)
     */
    _opDisconnect(op) {
        const targetDesc = op.parentConn || op.childConn;
        if (!targetDesc) return; // nothing to do
        const conn = this._connFromDesc(targetDesc);
        if (!conn?.isConnected?.()) return; // already disconnected
        const superior = conn.isSuperior?.() ? conn : (conn.targetConnection || conn);
        this._disconnectChild(superior, { dispose: !!op.disposeChild });
    }

    /** deleteBlock: { blockId } */
    _opDeleteBlock(op) {
        if (!this.opts.allowDelete) throw new Error("deleteBlock not allowed by applier config");
        const blk = this._getBlock(op.blockId, false);
        if (blk && !blk.isDisposed?.()) blk.dispose(true);
    }

    /** setField: { blockId, field, value } */
    _opSetField(op) {
        const { blockId, field, value } = op;
        if (!field) throw new Error("setField requires 'field'");
        const blk = this._getBlock(blockId);
        blk.setFieldValue(String(value), field);
    }

    /** moveBlock: { blockId, x, y } */
    _opMoveBlock(op) {
        const { blockId, x, y } = op;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("moveBlock requires numeric x,y");
        const blk = this._getBlock(blockId);
        blk.moveTo(new Blockly.utils.Coordinate(x, y));
    }


    // Inside your AgentActor class (add these methods)

    /** Extract the assistant JSON object from an OpenRouter/xAI (Grok) response. */
    static extractAssistantJSON(apiResponse) {
        const content = apiResponse?.choices?.[0]?.message?.content;
        if (!content) throw new Error("Grok response missing choices[0].message.content");

        if (typeof content === "object") {
            // Some providers may already return an object.
            return content;
        }

        if (typeof content === "string") {
            // Plain JSON?
            try { return JSON.parse(content); } catch (_) {}

            // Code-fenced JSON?
            const m = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
            if (m) {
                try { return JSON.parse(m[1]); } catch (e) {
                    throw new Error("Assistant content contained code-fenced JSON, but parsing failed.");
                }
            }
            throw new Error("Assistant content is not valid JSON.");
        }

        throw new Error("Unsupported assistant content format.");
    }

    /** Optional: coerce common numeric field strings to numbers (e.g., NUM: "0" -> 0). */
    static normalizeLLMResponse(llm) {
        try {
            const opsBuckets = [];
            const pushOps = (ops) => Array.isArray(ops) && opsBuckets.push(...ops);

            (llm?.editPlan?.steps || []).forEach(s => pushOps(s?.patch?.operations));
            (llm?.diagnostics?.proposedFixes || []).forEach(f => pushOps(f?.patch?.operations));

            for (const op of opsBuckets) {
                if (op?.op === "createBlock" && op.blockType === "math_number" && op.fields?.NUM != null) {
                    const v = op.fields.NUM;
                    if (typeof v === "string" && v.trim() !== "") {
                        const n = Number(v);
                        if (!Number.isNaN(n)) op.fields.NUM = n;
                    }
                }
            }
        } catch (e) {
            console.warn("normalizeLLMResponse skipped:", e);
        }
        return llm;
    }

    /**
     * COMPREHENSION helper:
     * Accepts either the raw Grok/OpenRouter API response or an already-parsed LLM JSON.
     * Returns the comprehension object (or a minimal fallback).
     */
    getComprehension(from) {
        const llm = from?.choices ? AgentActor.extractAssistantJSON(from) : from;
        const comp = llm?.comprehension || {};
        return {
            summary: comp.summary || "No summary provided.",
            blockId: comp.blockId ?? null,
            runtimeNotes: Array.isArray(comp.runtimeNotes) ? comp.runtimeNotes : [],
            voiceLine: llm?.voiceLine || ""
        };
    }

    /**
     * DEBUG helper:
     * Accepts either the raw API response or an already-parsed LLM JSON.
     * Returns the diagnostics object (or a minimal fallback).
     */
    getDiagnostics(from) {
        const llm = from?.choices ? AgentActor.extractAssistantJSON(from) : from;
        const diag = llm?.diagnostics || {};
        return {
            issues: Array.isArray(diag.issues) ? diag.issues : [],
            proposedFixes: Array.isArray(diag.proposedFixes) ? diag.proposedFixes : [],
            voiceLine: llm?.voiceLine || ""
        };
    }

    /**
     * EDIT_GUIDE helper:
     * Accepts either the raw API response or an already-parsed LLM JSON.
     * Returns the editPlan object (or a minimal fallback).
     */
    getEditPlan(from) {
        const llm = from?.choices ? AgentActor.extractAssistantJSON(from) : from;
        const plan = llm?.editPlan || {};
        return {
            steps: Array.isArray(plan.steps) ? plan.steps : [],
            voiceLine: llm?.voiceLine || ""
        };
    }

    /**
     * Show the comprehension in a simple alert (for now).
     * Pass either the raw Grok/OpenRouter response or the parsed LLM JSON.
     */
    showComprehensionAlert(from) {
        const c = this.getComprehension(from);
        const lines = [
            `Summary: ${c.summary}`,
            c.runtimeNotes?.length ? `Notes: ${c.runtimeNotes.join(" | ")}` : null,
            c.voiceLine ? `\n💬 ${c.voiceLine}` : null
        ].filter(Boolean);
        alert(lines.join("\n"));
    }

}
