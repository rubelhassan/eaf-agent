/**
 * Keyboard navigation states.
 * The different parts of Blockly that the user navigates between.
 * @enum {string}
 * @const
 * @public
 */
export const STATE = {
  WORKSPACE: 'workspace',
  FLYOUT: 'flyout',
  TOOLBOX: 'toolbox',
};

/**
 * Default keyboard navigation shortcut names.
 * @enum {string}
 * @const
 * @public
 */
export const SHORTCUT_NAMES = {
  PREVIOUS: 'previous',
  NEXT: 'next',
  IN: 'in',
  LAYER_IN: 'layer_in',
  LAYER_OUT: 'layer_out',
  OUT: 'out',
  INSERT: 'insert',
  MARK: 'mark',
  DISCONNECT: 'disconnect',
  TOOLBOX: 'toolbox',
  EXIT: 'exit',
  TOGGLE_KEYBOARD_NAV: 'toggle_keyboard_nav',
  COPY: 'keyboard_nav_copy',
  CUT: 'keyboard_nav_cut',
  PASTE: 'keyboard_nav_paste',
  DELETE: 'keyboard_nav_delete',
  UNDO: 'keyboard_nav_undo',
  MOVE_WS_CURSOR_UP: 'workspace_up',
  MOVE_WS_CURSOR_DOWN: 'workspace_down',
  MOVE_WS_CURSOR_LEFT: 'workspace_left',
  MOVE_WS_CURSOR_RIGHT: 'workspace_right',
  OUTPUT_FOCUS: 'output_focus',
  RUN_PROGRAM: 'run_program',
  EDIT_MODE: 'edit_mode',
  EDIT_STACK_LABEL: 'editStackLabel',
  STACK_SEARCH: 'stackSearch',
  CURSOR_LOC: 'cursor_location',
  ADD_COMMENT: "add_comment",
  MOVE_STATEMENT_UP: "keyboard_move_stmt_up",
  MOVE_STATEMENT_DOWN: "keyboard_move_stmt_down",
  SHOW_SHORTCUTS: 'show_shortcuts',
  SHOW_NAV_HINT: 'show_nav_hint',
  STACK_JUMP_PREFIX: 'stack_jump_',
  OPEN_DROPDOWN: "nav_drop_down",
  ZOOM_RESET: "nav_zoom_reset",
  ZOOM_IN: "nav_zoom_in",
  ZOOM_OUT: "nav_zoom_out",
};

/**
 * Types of possible messages passed into the loggingCallback in the Navigation
 * class.
 * @enum {string}
 * @const
 * @public
 */
export const LOGGING_MSG_TYPE = {
  ERROR: 'error',
  WARN: 'warn',
  LOG: 'log',
};


/**
 * Shortcut map for the Shortcut Assistance modal.
 */
export const SHORTCUT_HELP_ROWS = [
  {
    keys: ['W'],
    title: 'Navigation Mode: move cursor up to previous block',
    detail: 'Edit mode: move to the top connection.',
    sr: 'Shortcut key W. Move cursor up to the previous block in Navigation mode. And move to the top connection in Edit mode.'
  },
  {
    keys: ['S'],
    title: 'Navigation Mode: move cursor down to next block',
    detail: 'Edit mode: move to the bottom connection.',
    sr: 'Shortcut key S. Move cursor down to the next block in Navigation mode. And move to the bottom connection in Edit mode.'
  },
  {
    keys: ['A'],
    title: 'Navigation Mode: move cursor left to previous block',
    detail: 'Edit mode: move to the left connection.',
    sr: 'Shortcut key A. Move cursor left to the previous block in Navigation mode. And move to the left connection in Edit mode.'
  },
  {
    keys: ['D'],
    title: 'Navigation Mode: move cursor right to next block',
    detail: 'Edit mode: move to the right connection.',
    sr: 'Shortcut key D. Move cursor right to the next block in Navigation mode. And move to the right connection in Edit mode.'
  },
  {
    keys: ['F'],
    title: 'Navigation Mode: move to first nested block of current container block',
    detail: 'Edit Mode: move first nested connection of current block',
    sr: 'Shortcut key F. Move to the first nested block of the current container in Navigation mode. And move to the first nested connection of the current block in Edit mode.'
  },
  {
    keys: ['Q'],
    title: 'Move cursor out to parent block or outer layer',
    sr: 'Shortcut key Q. Move the cursor out to the parent block or outer layer.'
  },
  {
    keys: ['E'],
    title: 'Toggle Edit mode (enter or exit)',
    sr: 'Shortcut key E. Toggle Edit mode.'
  },
  {
    keys: ['T'],
    title: 'Open the toolbox',
    sr: 'Shortcut key T. Open the toolbox.'
  },
  {
    keys: ['Esc'],
    title: 'Close toolbox and return focus to workspace',
    sr: 'Shortcut key Escape. Close the toolbox and return focus to the workspace.'
  },
  {
    keys: ['C'],
    title: 'Announce current cursor location',
    sr: 'Shortcut key C. Announce the current cursor location.'
  },
  {
    keys: ['+', 'Shift + =', 'Numpad +'],
    title: 'Zoom in workspace',
    sr: 'Shortcut key Plus. Zoom in the workspace.'
  },
  {
    keys: ['-', 'Numpad -'],
    title: 'Zoom out workspace',
    sr: 'Shortcut key Minus. Zoom out the workspace.'
  },
  {
    keys: ['0', 'Numpad 0'],
    title: 'Reset zoom',
    sr: 'Shortcut key Zero. Reset the workspace zoom to the default scale.'
  },
  {
    keys: ['Ctrl', 'Shift', '+'],
    title: 'Focus magnifier: one level bigger (level 1, then level 2), also in a text field',
    sr: 'Shortcut keys Ctrl plus Shift plus Plus. Focus magnifier one level bigger: level 1, then level 2. Works while editing a text field.'
  },
  {
    keys: ['Ctrl', 'Shift', '-'],
    title: 'Focus magnifier: one level smaller; from level 1 it turns off',
    sr: 'Shortcut keys Ctrl plus Shift plus Minus. Focus magnifier one level smaller. From level 1 it turns off.'
  },
  {
    keys: ['Esc'],
    title: 'Turn the focus magnifier off (while it shows)',
    sr: 'Shortcut key Escape. Turns the focus magnifier off while it shows; press again for Escape\'s other jobs.'
  },
  {
    keys: ['Shift', 'X'],
    title: 'Disconnect block from current cursor location (Edit Mode Only)',
    sr: 'Shortcut keys Shift plus X. Disconnect the block from the current cursor location. Edit mode only.'
  },
  {
    keys: ['SHIFT', 'W'],
    title: 'Move the selected statement block upward (Navigation Mode Only)',
    sr: 'Shortcut keys Shift plus W. Move the selected statement block upward. Navigation mode only.'
  },
  {
    keys: ['SHIFT', 'S'],
    title: 'Move the selected statement block downward (Navigation Mode Only)',
    sr: 'Shortcut keys Shift plus S. Move the selected statement block downward. Navigation mode only.'
  },
  {
    keys: ['CTRL', 'X'],
    title: 'Cut (detach) the selected block (Navigation Mode Only)',
    sr: 'Shortcut keys Command (Mac) or Control (Windows) plus X. Cut the selected block. Navigation mode only.'
  },
  {
    keys: ['CTRL', 'V'],
    title: 'Paste (attach) detached block to a connection (Edit Mode Only)',
    sr: 'Shortcut keys Command (Mac) or Control (Windows) plus V. Paste the detached block to a connection. Edit mode only.'
  },
  {
    keys: ['Del'],
    title: 'Delete the selected block',
    sr: 'Shortcut key Delete. Delete the selected block.'
  },
  {
    keys: ['CTRL', '/'],
    title: 'Add or hide a comment on the selected block',
    sr: 'Shortcut keys Command (Mac) or Control (Windows) plus Slash. Add or hide a comment on the selected block.'
  },
  {
    keys: ['Shift', 'W'],
    title: 'Move workspace marker up',
    sr: 'Shortcut keys Shift plus W. Move the workspace marker up.'
  },
  {
    keys: ['Shift', 'S'],
    title: 'Move workspace marker down',
    sr: 'Shortcut keys Shift plus S. Move the workspace marker down.'
  },
  {
    keys: ['Shift', 'D'],
    title: 'Move workspace marker right',
    sr: 'Shortcut keys Shift plus D. Move the workspace marker right.'
  },
  {
    keys: ['Shift', 'A'],
    title: 'Move workspace marker left',
    sr: 'Shortcut keys Shift plus A. Move the workspace marker left.'
  },
  {
    keys: ['Shift', 'F'],
    title: 'Focus to the property of a block',
    sr: 'Shortcut keys Shift plus F. Move the the cursor to a block property.'
  },
  {
    keys: ['ALT', 'Shift', 'G'],
    title: 'Search stacks',
    sr: 'Shortcut keys Alt plus Shift plus G. Search stacks.'
  },
  {
    keys: ['ALT', 'A–Z'],
    title: 'Jump to a stack labelled with that letter',
    sr: 'Shortcut keys ALT plus any letter A through Z. Jump to a stack labeled with that letter.'
  },
  {
    keys: ['Shift', 'K'],
    title: 'Open or close this shortcuts list',
    sr: 'Shortcut keys Shift plus K. Open or close this shortcut help.'
  },
  {
    keys: ['Shift', 'I'],
    title: 'Customize stack label',
    sr: 'Shortcut keys Shift plus I. Open option to customize stack label'
  },
  {
    keys: ['Shift', 'H'],
    title: 'Open or close navigational Assistant',
    sr: 'Shortcut keys Shift plus H. Open or close this shortcut help.'
  },
  {
    keys: ['Shift', 'R'],
    title: 'Run the program',
    sr: 'Shortcut keys Shift plus R. Run the program'
  },
  {
    keys: ['Shift', 'O'],
    title: 'Open output panel',
    sr: 'Shortcut keys Shift plus O. Access the output panel'
  },
  {
    keys: ['Alt', 'Shift', 'Y'],
    title: 'Assistant: yes, do the offered step',
    sr: 'Shortcut keys Alt plus Shift plus Y. Assistant: yes, do the offered step.'
  },
  {
    keys: ['Alt', 'Shift', 'A'],
    title: 'Assistant: do all the remaining steps (when the task allows it)',
    sr: 'Shortcut keys Alt plus Shift plus A. Assistant: do all the remaining steps, when the task allows it.'
  },
  {
    keys: ['Alt', 'Shift', 'N'],
    title: 'Assistant: no, keep the step waiting',
    sr: 'Shortcut keys Alt plus Shift plus N. Assistant: no. Keep the step waiting; nothing changes.'
  },
  {
    keys: ['Alt', 'Shift', 'C'],
    title: 'Assistant: cancel the plan',
    sr: 'Shortcut keys Alt plus Shift plus C. Assistant: cancel the plan. Applied steps stay.'
  },
  {
    keys: ['Alt', 'Shift', 'U'],
    title: 'Assistant: undo the last step it made',
    sr: 'Shortcut keys Alt plus Shift plus U. Assistant: undo the last step the assistant made.'
  },
  {
    keys: ['Alt', 'Shift', 'R'],
    title: 'Assistant: repeat what it said',
    sr: 'Shortcut keys Alt plus Shift plus R. Assistant: repeat what the assistant said.'
  },
  {
    keys: ['Control'],
    title: 'Assistant: a tap of Control stops its voice',
    sr: 'Shortcut key Control, pressed alone. Stops the assistant voice.'
  },
  {
    keys: ['Control', 'Shift', 'I'],
    title: 'Assistant: stop its voice and talk',
    sr: 'Shortcut keys Control plus Shift plus I. Stops the assistant voice and listens to you.'
  },
  {
    keys: ['Control', 'Shift', 'V'],
    title: 'Assistant: start or end a voice conversation',
    sr: 'Shortcut keys Control plus Shift plus V. Start or end a voice conversation with the assistant.'
  },
  {
    keys: ['Escape'],
    title: 'Assistant: stop what it is working on',
    sr: 'Shortcut key Escape. Stop what the assistant is working on.'
  },
  {
    keys: ['MOD', 'Shift', 'K'],
    title: 'Enable/disable keyboard accessibility',
    sr: 'Shortcut keys Command (Mac) or Control (Windows) plus Shift plus K. Enable or disable keyboard accessibility.'
  }
];

