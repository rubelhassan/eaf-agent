/**
 * Rendered snapshots of toolbox blocks for the teacher's block picker. Each
 * toolbox item is rendered once in a hidden workspace (same renderer and theme as
 * the main one) and copied as inline SVG, so it matches the flyout exactly and
 * picks up Blockly's page styles.
 */

import * as Blockly from 'blockly/core';
import {QUESTION_TYPE} from '../model.js';

/** Blocks offered for dynamic categories, whose contents are generated at runtime. */
const DYNAMIC_CATEGORY_TYPES = {
  VARIABLE: ['variables_set', 'math_change', 'variables_get'],
  VARIABLE_DYNAMIC: ['variables_set', 'math_change', 'variables_get'],
  PROCEDURE: ['procedures_defnoreturn', 'procedures_defreturn', 'procedures_callnoreturn', 'procedures_callreturn'],
};

/**
 * Toolbox categories with the block items they offer (question blocks excluded).
 * @param {!Blockly.WorkspaceSvg} workspace
 * @returns {!Array<{name: string, items: !Array<!Object>}>} Items are block JSON (at least {type}).
 */
export function toolboxCatalog(workspace) {
  const categories = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      const kind = String(node.kind || '').toLowerCase();
      if (kind !== 'category') continue;
      const custom = node.custom && DYNAMIC_CATEGORY_TYPES[String(node.custom).toUpperCase()];
      const items = custom ?
        custom.map((type) => ({type})) :
        (node.contents || []).filter((c) => String(c.kind).toLowerCase() === 'block' && c.type !== QUESTION_TYPE);
      if (items.length) categories.push({name: node.name, items});
      walk(node.contents);
    }
  };
  walk(workspace.options.languageTree?.contents);
  return categories;
}

export class SnapshotRenderer {
  /** @param {!Blockly.WorkspaceSvg} workspace  The main workspace (renderer and theme source). */
  constructor(workspace) {
    this.workspace = workspace;
    /** @type {!Map<string, ?{svg: !SVGElement, width: number, height: number}>} */
    this.cache_ = new Map();
    this.host_ = null;
    this.scratch_ = null;
  }

  dispose() {
    this.scratch_?.dispose();
    this.host_?.remove();
    this.scratch_ = null;
    this.host_ = null;
    this.cache_.clear();
  }

  scratchWorkspace_() {
    if (this.scratch_) return this.scratch_;
    this.host_ = document.createElement('div');
    this.host_.setAttribute('aria-hidden', 'true');
    Object.assign(this.host_.style, {position: 'absolute', left: '-10000px', top: '0', width: '900px', height: '600px'});
    document.body.appendChild(this.host_);
    // Not readOnly: read-only fields get a class Blockly's CSS leaves unfilled (black boxes).
    this.scratch_ = Blockly.inject(this.host_, {
      renderer: this.workspace.options.renderer,
      theme: this.workspace.getTheme(),
      scrollbars: false,
      zoom: {startScale: 1},
    });
    // inject() makes the new workspace Blockly's main one; the program's workspace must stay main.
    Blockly.common.setMainWorkspace(this.workspace);
    return this.scratch_;
  }

  /**
   * A fresh inline <svg> showing the item, scaled to fit `maxHeight`, or null if
   * it cannot be rendered.
   * @param {!Object} item  Toolbox block JSON (at least {type}).
   * @param {number=} maxHeight
   * @returns {?SVGElement}
   */
  snapshot(item, maxHeight = 40) {
    const key = JSON.stringify(item);
    if (!this.cache_.has(key)) this.cache_.set(key, this.render_(item));
    const cached = this.cache_.get(key);
    if (!cached) return null;
    const svg = cached.svg.cloneNode(true);
    const scale = Math.min(1, maxHeight / cached.height);
    svg.setAttribute('width', String(Math.round(cached.width * scale)));
    svg.setAttribute('height', String(Math.round(cached.height * scale)));
    return svg;
  }

  render_(item) {
    const scratch = this.scratchWorkspace_();
    let block = null;
    Blockly.Events.disable();
    try {
      const {kind, ...state} = item;
      block = Blockly.serialization.blocks.append({...state, x: 0, y: 0}, scratch, {recordUndo: false});
      block.render();
      const box = block.getSvgRoot().getBBox();
      const NS = Blockly.utils.dom.SVG_NS;
      const svg = document.createElementNS(NS, 'svg');
      // Blockly's block styles are scoped by the renderer/theme classes, which sit on
      // the injection div (e.g. "geras-renderer classic-theme"); copy them here.
      const classes = scratch.getInjectionDiv().className.split(/\s+/)
          .filter((c) => c && c !== 'injectionDiv');
      svg.setAttribute('class', classes.join(' '));
      svg.style.cssText = 'display:block; position:static; overflow:visible; background:none;';
      svg.setAttribute('viewBox', `${box.x - 2} ${box.y - 2} ${box.width + 4} ${box.height + 4}`);
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const content = block.getSvgRoot().cloneNode(true);
      content.removeAttribute('transform');
      svg.appendChild(content);
      return {svg, width: box.width + 4, height: box.height + 4};
    } catch (e) {
      return null;
    } finally {
      block?.dispose(false);
      Blockly.Events.enable();
    }
  }
}
