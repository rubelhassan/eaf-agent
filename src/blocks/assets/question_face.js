/**
 * Hexagon ("diamond") question face: a pale-blue hexagon with a bold blue "?"
 * (documentation/rough_idea.png), usable as a Blockly FieldImage source.
 * Contrast: "?" #1F4FC1 on hexagon #DCE6FA is about 5.6:1.
 *
 * NOT USED by the current question block (redesigned 2026-09-28). Kept on purpose
 * for later phases, e.g. quiz prompts. Usage:
 *   new Blockly.FieldImage(faceImage(FACE_WIDTH.value), FACE_WIDTH.value, FACE_HEIGHT, 'question')
 */

const HEIGHT = 26;
const HEX_HALF_WIDTH = 20;

/** Image widths: compact for value sockets, a statement-like bar for stacks. */
export const FACE_WIDTH = Object.freeze({value: 44, statement: 150});
export const FACE_HEIGHT = HEIGHT;

/**
 * @param {number} width  Image width; the hexagon is centered in it.
 * @returns {string} A data: URI for an SVG image.
 */
export function faceImage(width) {
  const cx = width / 2;
  const h = HEX_HALF_WIDTH;
  const points = [
    [cx - h, HEIGHT / 2], [cx - h + 8, 1], [cx + h - 8, 1],
    [cx + h, HEIGHT / 2], [cx + h - 8, HEIGHT - 1], [cx - h + 8, HEIGHT - 1],
  ].map(([x, y]) => `${x},${y}`).join(' ');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}">` +
    `<polygon points="${points}" fill="#DCE6FA"/>` +
    `<text x="${cx}" y="${HEIGHT / 2 + 6}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" ` +
    `font-size="18" font-weight="700" fill="#1F4FC1">?</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
