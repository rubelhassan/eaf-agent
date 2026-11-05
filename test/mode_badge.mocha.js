/**
 * Unit tests for the Navigation/Edit mode badge (src/util/mode_badge.js).
 * Run with `npm test`.
 */

import {assert} from 'chai';
import {JSDOM} from 'jsdom';

import {ModeBadge} from '../src/util/mode_badge.js';

suite('Mode badge', function() {
  setup(function() {
    this.host = new JSDOM('<!doctype html><body></body>').window.document.createElement('div');
    this.workspace = {keyboardAccessibilityMode: false, getInjectionDiv: () => this.host};
    this.cursor = {editMode: false};
    this.badge = new ModeBadge();
    this.badge.attach(this.workspace, this.cursor);
    this.el = () => this.host.querySelector('.eaf-mode-badge');
  });

  teardown(function() {
    this.badge.dispose();
  });

  test('is hidden while keyboard navigation is off', function() {
    assert.isTrue(this.el().hidden);
  });

  test('shows Navigation mode, then Edit mode as the cursor toggles', function() {
    this.workspace.keyboardAccessibilityMode = true;
    assert.isFalse(this.el().hidden);
    assert.equal(this.el().textContent, 'Navigation mode');
    assert.isTrue(this.el().classList.contains('eaf-mode-badge-navigation'));

    this.cursor.editMode = true;
    assert.equal(this.el().textContent, 'Edit mode');
    assert.isTrue(this.el().classList.contains('eaf-mode-badge-edit'));

    this.cursor.editMode = false;
    assert.equal(this.el().textContent, 'Navigation mode');
  });

  test('hides again when keyboard navigation is turned off', function() {
    this.workspace.keyboardAccessibilityMode = true;
    this.cursor.editMode = true;
    this.workspace.keyboardAccessibilityMode = false;
    assert.isTrue(this.el().hidden);
  });

  test('setEnabled(false) hides it for hosts that opt out', function() {
    this.workspace.keyboardAccessibilityMode = true;
    this.badge.setEnabled(false);
    assert.isTrue(this.el().hidden);
  });

  test('dispose removes the badge and restores plain properties', function() {
    this.cursor.editMode = true;
    this.badge.dispose();
    assert.isNull(this.el());
    assert.isUndefined(Object.getOwnPropertyDescriptor(this.cursor, 'editMode').get);
    assert.isTrue(this.cursor.editMode);
  });
});
