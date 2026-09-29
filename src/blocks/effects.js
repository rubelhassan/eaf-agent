/**
 * Small visual effects for custom blocks. Purely visual (no workspace events),
 * and skipped when the learner's system asks for reduced motion.
 */

import * as Blockly from 'blockly/core';

export const VANISH_MS = 250;

function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Leaves a fading, shrinking copy of a rendered block where it is, so the block
 * itself can be disposed right away.
 * @param {!Blockly.BlockSvg} block
 */
export function vanish(block) {
  const root = block?.getSvgRoot?.();
  if (!root || !root.parentNode || prefersReducedMotion()) return;

  const NS = Blockly.utils.dom.SVG_NS;
  const holder = document.createElementNS(NS, 'g');
  holder.setAttribute('transform', root.getAttribute('transform') || '');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.pointerEvents = 'none';

  const ghost = root.cloneNode(true);
  ghost.removeAttribute('transform');
  ghost.removeAttribute('id');
  ghost.style.transformBox = 'fill-box';
  ghost.style.transformOrigin = 'center';
  ghost.style.transition = `opacity ${VANISH_MS}ms ease-out, transform ${VANISH_MS}ms ease-out`;
  holder.appendChild(ghost);
  root.parentNode.appendChild(holder);

  requestAnimationFrame(() => {
    ghost.style.opacity = '0';
    ghost.style.transform = 'scale(0.6)';
  });
  setTimeout(() => holder.remove(), VANISH_MS + 50);
}
