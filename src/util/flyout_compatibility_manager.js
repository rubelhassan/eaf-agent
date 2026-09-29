import {blockTypes} from '../blocks/registry';

/**
 * Manages flyout block compatibility filtering based on connection type constraints
 */
export class FlyoutCompatibilityManager {
    static DISABLED_REASON = 'acc_incompatible_connection';

    /**
     * Gets the connection currently selected by the keyboard cursor.
     * @param {!Blockly.WorkspaceSvg} workspace The main workspace.
     * @returns {?Blockly.RenderedConnection} The selected connection or null.
     */
    getSelectedConnection(workspace) {
        const cursorNode = workspace?.getCursor?.()?.getCurNode?.();

        if (!cursorNode || typeof cursorNode.isConnection !== 'function') {
            return null;
        }

        return cursorNode.isConnection() ? cursorNode.getLocation() : null;
    }

    /**
     * Extracts the type check constraint from a connection.
     * @param {?Blockly.RenderedConnection} connection The connection to check.
     * @returns {?Array<string>} Array of type strings, or null if unconstrained.
     */
    getConnectionCheck(connection) {
        if (!connection) return null;

        // Prefer the public getter if available (Blockly API).
        if (typeof connection.getCheck === 'function') {
            return connection.getCheck();
        }

        // Fallback for older Blockly builds.
        return connection.check_ ?? null;
    }

    /**
     * Determines if two type constraint arrays have compatible types.
     * null/undefined means "accepts anything".
     *
     * @param {?Array<string>} checkA First constraint array.
     * @param {?Array<string>} checkB Second constraint array.
     * @returns {boolean} True if the arrays have overlapping types.
     */
    doChecksOverlap(checkA, checkB) {
        // If either is unconstrained, they're compatible.
        if (!checkA || !checkB) {
            return true;
        }

        // Check if any type in A exists in B.
        return checkA.some(typeA => checkB.includes(typeA));
    }

    /**
     * Checks if a candidate block has a connection compatible with the destination.
     * Only considers connection type and type checks, not workspace geometry.
     *
     * @param {!Blockly.RenderedConnection} destConnection The connection to attach to.
     * @param {!Blockly.BlockSvg} candidateBlock The block being considered.
     * @returns {boolean} True if the block has a compatible connection.
     */
    isBlockCompatibleWithConnection(destConnection, candidateBlock) {
        if (!destConnection || !candidateBlock) {
            return false;
        }
        // Custom block types may redirect the target, adapt their shape, or add rules.
        return blockTypes.isInsertCompatible(candidateBlock, destConnection,
            (target, block) => this.fitsStructurally(target, block));
    }

    /**
     * Shape and type-check compatibility only (no custom block rules).
     * @param {!Blockly.RenderedConnection} destConnection The connection to attach to.
     * @param {!Blockly.BlockSvg} candidateBlock The block being considered.
     * @returns {boolean}
     */
    fitsStructurally(destConnection, candidateBlock) {
        const destType = destConnection.type;
        const destCheck = this.getConnectionCheck(destConnection);

        const isConnectionCompatible = (sourceConnection) => {
            if (!sourceConnection) return false;
            const sourceCheck = this.getConnectionCheck(sourceConnection);
            return this.doChecksOverlap(sourceCheck, destCheck);
        };

        // Map destination connection types to required source connection types.
        switch (destType) {
            case Blockly.PREVIOUS_STATEMENT:
                // Parent wants a statement above → candidate must offer NEXT.
                return isConnectionCompatible(candidateBlock.nextConnection);

            case Blockly.NEXT_STATEMENT:
                // Parent has a NEXT slot → candidate must offer PREVIOUS.
                return isConnectionCompatible(candidateBlock.previousConnection);

            case Blockly.INPUT_VALUE:
                // Parent has a value input → candidate must offer OUTPUT.
                return isConnectionCompatible(candidateBlock.outputConnection);

            case Blockly.OUTPUT_VALUE:
                // Parent is an OUTPUT (value) → candidate must have an INPUT_VALUE.
                return this.blockHasCompatibleValueInput(candidateBlock, destCheck);

            default:
                return false;
        }
    }


    /**
     * Checks if a block has at least one INPUT_VALUE that's compatible with the check.
     * @param {!Blockly.BlockSvg} block The block to check.
     * @param {?Array<string>} destCheck The destination's type check.
     * @returns {boolean} True if a compatible INPUT_VALUE exists.
     */
    blockHasCompatibleValueInput(block, destCheck) {
        if (!block.inputList) return false;

        for (const input of block.inputList) {
            const connection = input?.connection;
            if (!connection || connection.type !== Blockly.INPUT_VALUE) {
                continue;
            }

            const sourceCheck = this.getConnectionCheck(connection);
            if (this.doChecksOverlap(sourceCheck, destCheck)) {
                return true;
            }
        }

        return false;
    }


    /**
     * Clears all compatibility-based disabled reasons from flyout blocks.
     * Call this before applying new filters to remove stale state.
     */
    clearFlyoutDisabledReasons(workspace) {
        const flyoutWorkspace = workspace?.getFlyout?.()?.getWorkspace?.();
        if (!flyoutWorkspace) return;

        const blocks = flyoutWorkspace.getTopBlocks?.(false) || [];
        const reason = FlyoutCompatibilityManager.DISABLED_REASON;

        for (const block of blocks) {
            try {
                block.setDisabledReason(false, reason);
            } catch (e) {
                console.warn('Failed to clear disabled reason on flyout block:', e);
            }
        }
    }


    /**
     * Updates the disabled state of flyout blocks based on compatibility with
     * the given destination connection.
     *
     * @param {!Blockly.WorkspaceSvg} workspace The main workspace.
     * @param {!Blockly.RenderedConnection} destConnection The selected connection.
     */
    updateFlyoutBlockCompatibility(workspace, destConnection) {
        const flyoutWorkspace = workspace?.getFlyout?.()?.getWorkspace?.();
        if (!flyoutWorkspace) return;

        const blocks = flyoutWorkspace.getTopBlocks?.(false) || [];
        const reason = FlyoutCompatibilityManager.DISABLED_REASON;

        for (const block of blocks) {
            let isCompatible = false;

            try {
                isCompatible = this.isBlockCompatibleWithConnection(destConnection, block);
            } catch (e) {
                console.error('Error checking block compatibility:', e);
            }

            try {
                block.setDisabledReason(!isCompatible, reason);
            } catch (e) {
                console.warn('Failed to set disabled reason on flyout block:', e);
            }
        }
    }

    /**
     * Applies compatibility filtering to the flyout.
     * Only filters when the cursor is in edit mode and a connection is selected.
     *
     * @param {!Blockly.WorkspaceSvg} workspace The main workspace.
     */
    applyFilter(workspace) {
        const cursor = workspace?.getCursor?.();

        // Always clear stale filtering state first.
        this.clearFlyoutDisabledReasons(workspace);

        // Only filter in edit mode.
        if (!cursor?.editMode) {
            return;
        }

        const destConnection = this.getSelectedConnection(workspace);
        if (!destConnection) {
            return; // No selected connection → nothing to filter.
        }

        this.updateFlyoutBlockCompatibility(workspace, destConnection);
    }
}
