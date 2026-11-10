// Application dialogs share navigation speech. Native focus already serves screen readers.
import {getOutputManager, systemVoiceOn} from '../output/active.js';

function referencedText(element, attribute) {
  return (element.getAttribute(attribute) || '').split(/\s+/)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent || '').join(' ').trim();
}

function controlName(element) {
  const aria = referencedText(element, 'aria-labelledby') || element.getAttribute('aria-label');
  if (aria) return aria;
  if (element.labels?.length) {
    return [...element.labels].map((label) => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll('input, textarea, select, button').forEach((control) => control.remove());
      return [...copy.childNodes].map((node) => node.textContent.trim()).filter(Boolean).join(' ');
    }).join(' ');
  }
  return element.dataset.sr || element.textContent.trim();
}

/** The accessible label, current value, state and description of a focused control. */
export function controlSpeech(element) {
  if (!element) return '';
  const activeId = element.getAttribute('aria-activedescendant');
  const active = activeId && element.ownerDocument.getElementById(activeId);
  if (active) return controlSpeech(active);
  const parts = [controlName(element)];
  if (element.matches('select')) parts.push(element.selectedOptions[0]?.textContent || 'blank');
  else if (element.matches('input[type="checkbox"], input[type="radio"]')) parts.push(element.checked ? 'checked' : 'not checked');
  else if (element.matches('input:not([type="password"]), textarea')) parts.push(element.value || 'blank');
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') parts.push('unavailable');
  if (element.hasAttribute('aria-expanded')) parts.push(element.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
  const description = referencedText(element, 'aria-describedby');
  if (description) parts.push(description);
  let text = '';
  for (const part of parts.filter(Boolean)) {
    if (text) text += /[.!?]$/.test(text) ? ' ' : '. ';
    text += part;
  }
  return text;
}

/** Focus changes are spoken only with navigation on the built-in voice. */
export function speakDialogFocus(element) {
  if (!systemVoiceOn()) return;
  const text = controlSpeech(element);
  if (text) getOutputManager().say({source: 'system', kind: 'navigation', text});
}

/** A status goes to one route: the system voice, a local live region, or the host's fallback. */
export function sayDialog(text, {liveRegion = null, fallback = null} = {}) {
  const output = getOutputManager();
  if (liveRegion) liveRegion.setAttribute('aria-live', systemVoiceOn() ? 'off' : 'polite');
  if (systemVoiceOn() || !liveRegion && output) {
    output.say({source: 'system', kind: 'navigation', text});
  } else if (liveRegion) {
    liveRegion.textContent = '';
    liveRegion.textContent = text;
  } else {
    fallback?.(text);
  }
}
