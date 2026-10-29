// @ts-check
// A short hash of the serialized program: replies, offers and cache keys say which program they were made for.

import * as Blockly from 'blockly/core';

/** @returns {string} */
export function workspaceVersion(ws) {
  const text = JSON.stringify(Blockly.serialization.workspaces.save(ws));
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) | 0;
  return h.toString(36);
}
