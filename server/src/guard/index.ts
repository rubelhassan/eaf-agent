// The guard on the way in and out: mask personal information, restore it in the reply. Off-topic is the intent model's call.

import type {AgentCall} from '../envelope.js';
import {maskCall, maskKnown, maskWords, newMaskMap, restore, type MaskMap} from './mask.js';
import type {FindEntities} from './ner.js';

export interface Guard {
  mask(call: AgentCall): Promise<{call: AgentCall; map: MaskMap}>;
  /** Free text on its own (an event's words), with every finder. */
  maskText(text: string): Promise<string>;
  maskKnown(text: string, map: MaskMap): string;
  restore(text: string, map: MaskMap): {text: string; unknown: string[]};
}

/** @param ner the local name finder; null means patterns and cue phrases only (tests) */
export function createGuard({ner}: {ner: FindEntities | null}): Guard {
  return {
    mask: (call) => maskCall(call, ner),
    maskText: (text) => maskWords(text, newMaskMap(), ner),
    maskKnown,
    restore,
  };
}
