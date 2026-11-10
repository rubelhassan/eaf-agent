/**
 * The dark theme (approved 2026-11-04). Text is at least 7:1 on its background; block text is white on softened
 * block colours (7.2:1 each), with a light outline around every block; focus and the navigation cursor are yellow.
 */
(function () {
    // Block colour (white text 7.2:1) and the category's symbol in the toolbox.
    const CATEGORIES = {
        logic: { colour: '#315a82', style: 'logic_blocks', symbol: '?' },
        loops: { colour: '#266326', style: 'loop_blocks', symbol: '↻' },
        math: { colour: '#3f50a6', style: 'math_blocks', symbol: '+' },
        text: { colour: '#25614d', style: 'text_blocks', symbol: 'T' },
        lists: { colour: '#6541ac', style: 'list_blocks', symbol: '≡' },
        variables: { colour: '#903763', style: 'variable_blocks', symbol: 'x' },
        procedures: { colour: '#823791', style: 'procedure_blocks', symbol: 'f' },
    };
    const OUTLINE = '#aab4c3';
    const FOCUS = '#ffd400';

    const blockStyles = {};
    const categoryStyleColours = {};
    const categoryStyles = {};
    const symbols = {};
    for (const [key, { colour, style, symbol }] of Object.entries(CATEGORIES)) {
        blockStyles[style] = { colourPrimary: colour, colourSecondary: colour, colourTertiary: OUTLINE };
        categoryStyleColours[`${key}_category`] = { colour };
        categoryStyles[key] = `${key}_category`;
        // Decorative in the toolbox; screen readers still hear just the name.
        symbols[`--eaf-symbol-${key}`] = `"${symbol}\\00a0\\00a0"`;
    }
    blockStyles.variable_dynamic_blocks = blockStyles.variable_blocks;

    window.eafThemes.register({
        name: 'dark',
        label: 'Dark',
        outlinedBlocks: true,
        categoryStyles,
        css: {
            // Page and panels.
            '--eaf-page': '#121417',
            '--eaf-surface': '#1b1e24',
            '--eaf-surface-alt': '#242832',
            '--eaf-fg': '#f1f3f7',
            '--eaf-fg-muted': '#c3cad6',
            '--eaf-fg-disabled': '#8b93a3',
            '--eaf-line': '#4b5260',
            '--eaf-line-soft': '#343944',
            '--eaf-selected-bg': '#24305a',
            '--eaf-accent': '#8fb4ff',
            '--eaf-accent-strong': '#c8d6ff',
            '--eaf-accent-bg': '#2a3550',
            '--eaf-accent-line': '#4a5f8f',
            '--eaf-accent-active': '#33416a',
            '--eaf-on-accent': '#0b0f1a',
            '--eaf-button-bg': '#1b1e24',
            '--eaf-focus': FOCUS,
            '--eaf-warn': '#ffab91',
            '--eaf-ok-fg': '#86EFAC',
            '--eaf-bad-fg': '#FCA5A5',
            // Header toggles and badges.
            '--eaf-pill-bg': '#242832',
            '--eaf-pill-fg': '#f1f3f7',
            '--eaf-pill-line': '#8b93a3',
            '--eaf-pill-on-bg': '#24305a',
            '--eaf-teacher-bg': '#173523',
            '--eaf-teacher-fg': '#b7f0cc',
            '--eaf-teacher-line': '#5fc48a',
            '--eaf-quiz-bg': '#4A1414',
            '--eaf-quiz-fg': '#FECACA',
            '--eaf-quiz-line': '#F87171',
            // Brand: Blockly and (AI Tutor) 7.6:1, Neon 10.6:1 on the page.
            '--brand-word': '#7aa7f7',
            '--brand-name': '#b5c1ff',
            // Blocks.
            '--eaf-grid': '#3a404c',
            '--eaf-block-outline': OUTLINE,
            ...symbols,
            // The assistant panel.
            '--assistant-blue': '#8fb4ff',
            '--assistant-blue-dark': '#b5c8ff',
            '--assistant-on-blue': '#0b0f1a',
            '--assistant-bg': '#1b1e24',
            '--assistant-fg': '#f1f3f7',
            '--assistant-muted': '#c3cad6',
            '--assistant-faint': '#b3bbc8',
            '--assistant-border': '#8b93a3',
            '--assistant-line': '#4b5260',
            '--assistant-accent': '#7fe0a0',
            '--assistant-accent-bg': '#173523',
            '--assistant-accent-fg': '#0b0f1a',
            // On the blue panel header: its subtitle and button outlines.
            '--assistant-accent-soft': '#141c36',
            '--assistant-user-bg': '#1b1e24',
            '--assistant-reply-bg': '#242832',
            '--assistant-chat-bg': '#15171c',
            '--assistant-focus': FOCUS,
            '--assistant-inactive-bg': '#242832',
            '--assistant-shade': 'rgb(0 0 0 / 60%)',
            '--assistant-avatar-bg': '#c3cad6',
            '--assistant-engine-warn': '#ffb27a',
            '--assistant-step-line': '#4b5260',
            '--assistant-step-state': '#8b93a3',
        },
        blockly: {
            blockStyles,
            categoryStyles: categoryStyleColours,
            componentStyles: {
                workspaceBackgroundColour: '#121417',
                toolboxBackgroundColour: '#1b1e24',
                toolboxForegroundColour: '#f1f3f7',
                flyoutBackgroundColour: '#242832',
                flyoutForegroundColour: '#f1f3f7',
                flyoutOpacity: 1,
                scrollbarColour: '#8b93a3',
                scrollbarOpacity: 0.7,
                insertionMarkerColour: '#ffffff',
                insertionMarkerOpacity: 0.3,
                cursorColour: FOCUS,
                markerColour: FOCUS,
                selectedGlowColour: FOCUS,
                selectedGlowOpacity: 1,
            },
        },
    });
})();
