/**
 * Custom block type registry.
 *
 * One place where a custom block type declares how it plugs into the plugin:
 * its Blockly definition, code generators, speech, keyboard activation, and
 * connection behavior. Navigation, speech, and the connection checker consult
 * this registry through the dispatch methods below, so adding a new block type
 * never requires touching those modules again.
 *
 * Blockly's own block and generator registries are global, so this registry is
 * a module-level singleton (`blockTypes`).
 */

import * as Blockly from 'blockly/core';

/**
 * @typedef {Object} ActivateContext
 * @property {!Blockly.WorkspaceSvg} workspace
 * @property {{update: function(string): void}} speech  Announces text to the learner.
 */

/**
 * @typedef {Object} CustomBlockType
 * @property {string} type  Blockly block type id.
 * @property {function(): void} define  Registers the Blockly definition (Blockly.Blocks[type]).
 * @property {function(!Blockly.Block, !Blockly.CodeGenerator, string): (string|Array)=} generate
 *     Language-agnostic generator: (block, generator, language) → code or [code, order].
 * @property {function(!Blockly.Block): ?string=} describe
 *     Short spoken name used when the block is mentioned inside another block's description.
 * @property {function(!Blockly.Block): ?string=} focusText
 *     Spoken line when the learner's cursor lands on the block.
 * @property {function(!Blockly.Block, !ActivateContext): boolean=} activate
 *     Enter on the block. Return true if handled.
 * @property {function(!Blockly.ASTNode, !Blockly.ASTNode): ?Blockly.ASTNode=} redirectTarget
 *     Before a keyboard connect: (markerNode, cursorNode) → a replacement marker node, or null to keep it.
 *     Consulted for every registered type (the marker's owner decides).
 * @property {function(!Blockly.Block, !Blockly.ASTNode): void=} adaptToTarget
 *     Before a keyboard connect of a block of THIS type: reshape it to fit the marker.
 * @property {function(!Blockly.Block, !Blockly.Connection): boolean=} canAdaptTo
 *     Whether adaptToTarget can make a block of THIS type fit the connection
 *     (lets the flyout keep it enabled even though its current shape does not fit).
 * @property {function(!Blockly.Connection, !Blockly.Connection): boolean=} allowsConnection
 *     Extra connection rule, checked after Blockly's own type checks, for every connection attempt.
 * @property {function(!Blockly.Block, !Blockly.Connection): ?string=} explainRejection
 *     Spoken reason why a block cannot connect to a target connection this type governs.
 * @property {function(!Blockly.Block, boolean): void=} onEditTarget
 *     Keyboard Edit mode started (true) or ended (false) on a block of THIS type.
 * @property {function(!Blockly.Block): ?string=} editLock
 *     While in Edit mode on a block of THIS type, a spoken reason if moving between
 *     its connections is not allowed (null to allow).
 * @property {function(!Blockly.Workspace, !Object): {dispose: function()}=} attach
 *     Per-workspace setup (listeners, overlays), run by attachCustomBlocks with host services.
 * @property {BlockDecorator=} decorator
 *     Behavior this type adds to OTHER blocks (e.g. blocks that answer a question).
 */

/**
 * @typedef {Object} BlockDecorator
 * @property {function(!Blockly.Block): ?string=} focusSuffix
 *     Extra sentence appended to any block's focus announcement.
 * @property {function(!Blockly.Block, !ActivateContext): boolean=} activate
 *     Enter on any block. Return true if handled.
 * @property {function(!Blockly.Block): ?string=} flyoutNote
 *     Short note spoken after a flyout block's name (e.g. "suggested").
 * @property {function(!Object, !Blockly.Workspace): ?string=} categoryNote
 *     Short note spoken after a toolbox category's name (e.g. "has suggested blocks").
 */

/**
 * Code generator languages the registry knows how to install into.
 * @type {!Array<string>}
 */
export const GENERATOR_LANGUAGES = ['javascript', 'python', 'php', 'lua', 'dart'];

/**
 * What the keyboard navigation host (NavigationController) offers custom blocks.
 * @typedef {Object} NavigationHost
 * @property {function(!Blockly.WorkspaceSvg, {items: !Array<!Object>, target: !Blockly.Connection,
 *     anchor: !Blockly.Block, message: string}): boolean} showChoices
 *     Shows blocks in the flyout, ready to insert at `target`; `anchor` is where
 *     keyboard Edit mode starts. Returns false if there is no flyout.
 */

export class BlockTypeRegistry {
  constructor() {
    /** @private @type {!Map<string, !CustomBlockType>} */
    this.types_ = new Map();
    /** @private @type {?NavigationHost} */
    this.host_ = null;
  }

  /** @param {?NavigationHost} host */
  setNavigationHost(host) {
    this.host_ = host;
  }

  /** @returns {?NavigationHost} */
  navigationHost() {
    return this.host_;
  }

  /**
   * @param {!CustomBlockType} def
   * @returns {!CustomBlockType}
   */
  register(def) {
    if (!def?.type || typeof def.define !== 'function') {
      throw new Error('Custom block type needs `type` and `define()`.');
    }
    if (this.types_.has(def.type)) {
      throw new Error(`Custom block type already registered: ${def.type}`);
    }
    this.types_.set(def.type, def);
    return def;
  }

  /**
   * @param {string} type
   * @returns {?CustomBlockType}
   */
  get(type) {
    return this.types_.get(type) || null;
  }

  /** @returns {boolean} */
  has(type) {
    return this.types_.has(type);
  }

  /** @returns {!Array<!CustomBlockType>} */
  all() {
    return [...this.types_.values()];
  }

  /** Defines every registered type with Blockly. Safe to call more than once. */
  defineAll() {
    for (const def of this.types_.values()) {
      if (!Blockly.Blocks[def.type]) def.define();
    }
  }

  /**
   * Installs generators for every registered type into the given code generators.
   * @param {!Object<string, !Blockly.CodeGenerator>} generators  Keyed by language (see GENERATOR_LANGUAGES).
   */
  installGenerators(generators) {
    this.generators_ = {...(this.generators_ || {}), ...(generators || {})};
    for (const [language, generator] of Object.entries(generators || {})) {
      if (!generator?.forBlock) continue;
      for (const def of this.types_.values()) {
        if (!def.generate) continue;
        generator.forBlock[def.type] = (block, gen) => def.generate(block, gen, language);
      }
    }
  }

  /** @returns {?Blockly.CodeGenerator} An installed code generator (e.g. 'javascript'). */
  generator(language) {
    return this.generators_?.[language] || null;
  }

  // ---- Dispatch used by speech, navigation, and the connection checker ----

  /** @returns {?string} */
  describe(block) {
    return block ? this.get(block.type)?.describe?.(block) ?? null : null;
  }

  /** @returns {?string} */
  focusText(block) {
    return block ? this.get(block.type)?.focusText?.(block) ?? null : null;
  }

  /** @returns {?string} Sentences decorators add to a block's focus announcement. */
  focusSuffix(block) {
    if (!block) return null;
    const parts = this.all().map((def) => def.decorator?.focusSuffix?.(block)).filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }

  /** @returns {?string} Notes decorators add after a flyout block's name. */
  flyoutNote(block) {
    if (!block) return null;
    const notes = this.all().map((def) => def.decorator?.flyoutNote?.(block)).filter(Boolean);
    return notes.length ? notes.join(', ') : null;
  }

  /** @returns {?string} Notes decorators add after a toolbox category's name. */
  categoryNote(category, workspace) {
    if (!category) return null;
    const notes = this.all().map((def) => def.decorator?.categoryNote?.(category, workspace)).filter(Boolean);
    return notes.length ? notes.join(', ') : null;
  }

  /**
   * @param {!Blockly.Block} block
   * @param {!ActivateContext} context
   * @returns {boolean} True if the block's type or a decorator handled the activation.
   */
  activate(block, context) {
    if (!block) return false;
    const def = this.get(block.type);
    if (def?.activate && def.activate(block, context) === true) return true;
    return this.all().some((d) => d.decorator?.activate?.(block, context) === true);
  }

  /**
   * Runs every type's per-workspace setup.
   * @param {!Blockly.Workspace} workspace
   * @param {{announce?: function(string): void, onEvent?: function(string, !Object): void}=} options  Host services
   *     (speech, and the event log).
   * @returns {{dispose: function()}}
   */
  attachAll(workspace, options = {}) {
    const attachments = this.all().map((def) => def.attach?.(workspace, options)).filter(Boolean);
    return {dispose: () => attachments.forEach((a) => a.dispose())};
  }

  /**
   * The connection a keyboard connect should really target (custom types may
   * redirect it). No side effects.
   * @param {!Blockly.ASTNode} markerNode
   * @param {!Blockly.ASTNode} cursorNode
   * @returns {!Blockly.ASTNode}
   */
  resolveTarget(markerNode, cursorNode) {
    if (!markerNode || !cursorNode) return markerNode;
    let target = markerNode;
    for (const def of this.types_.values()) {
      const redirected = def.redirectTarget?.(target, cursorNode);
      if (redirected) target = redirected;
    }
    return target;
  }

  /**
   * Called before a keyboard connect (insert from flyout, paste, or move to marker).
   * Resolves the target and lets the moving block's type reshape it to fit.
   * @param {!Blockly.ASTNode} markerNode
   * @param {!Blockly.ASTNode} cursorNode
   * @returns {!Blockly.ASTNode} The marker node to use.
   */
  prepareConnect(markerNode, cursorNode) {
    if (!markerNode || !cursorNode) return markerNode;
    const target = this.resolveTarget(markerNode, cursorNode);
    const movingBlock = cursorNode.getSourceBlock?.();
    this.get(movingBlock?.type)?.adaptToTarget?.(movingBlock, target);
    return target;
  }

  /**
   * Keyboard-insert compatibility of a (flyout) block with a target connection,
   * accounting for redirects, adapters, and custom rules.
   * @param {!Blockly.Block} block
   * @param {!Blockly.Connection} connection  The marked/selected connection.
   * @param {function(!Blockly.Connection, !Blockly.Block): boolean} fitsStructurally
   *     The caller's own shape/type-check test, used unless the block can adapt.
   * @returns {boolean}
   */
  isInsertCompatible(block, connection, fitsStructurally) {
    const node = this.resolveTarget(
        Blockly.ASTNode.createConnectionNode(connection),
        Blockly.ASTNode.createBlockNode(block),
    );
    const target = node?.isConnection() ? node.getLocation() : connection;
    const adapts = !!this.get(block.type)?.canAdaptTo?.(block, target);
    if (!adapts && !fitsStructurally(target, block)) return false;
    return !this.explainRejection(block, target);
  }

  /**
   * @param {!Blockly.Connection} a
   * @param {!Blockly.Connection} b
   * @returns {boolean} False if any custom rule forbids the connection.
   */
  allowsConnection(a, b) {
    for (const def of this.types_.values()) {
      if (def.allowsConnection && !def.allowsConnection(a, b)) return false;
    }
    return true;
  }

  /**
   * @param {!Blockly.Block} block  The block the learner tried to connect.
   * @param {!Blockly.Connection} target  The marked connection.
   * @returns {?string} A spoken reason, or null if no custom rule explains it.
   */
  explainRejection(block, target) {
    for (const def of this.types_.values()) {
      const reason = def.explainRejection?.(block, target);
      if (reason) return reason;
    }
    return null;
  }

  /**
   * Tells block types which block keyboard Edit mode is on (null when it ends).
   * @param {!Blockly.Workspace} workspace
   * @param {?Blockly.Block} block
   */
  editTargetChanged(workspace, block) {
    if (!this.editTargets_) this.editTargets_ = new WeakMap();
    const previous = this.editTargets_.get(workspace) || null;
    if (previous === block) return;
    this.editTargets_.set(workspace, block);
    if (previous && !previous.isDisposed?.()) this.types_.get(previous.type)?.onEditTarget?.(previous, false);
    if (block) this.types_.get(block.type)?.onEditTarget?.(block, true);
  }

  /** @returns {?string} Why connection moves are locked while editing `block`, or null. */
  editLock(block) {
    return (block && this.types_.get(block.type)?.editLock?.(block)) || null;
  }
}

/** The plugin-wide registry. */
export const blockTypes = new BlockTypeRegistry();
