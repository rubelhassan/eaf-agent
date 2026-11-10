/**
 * Colour themes. A theme is one object: its CSS custom properties (the --eaf-*, --assistant-* and --brand-* tokens
 * the app and the plugin read), its Blockly theme parts, the category symbols, and whether blocks get outlines.
 * The light theme is the CSS defaults (every var's fallback), so it sets few or none.
 * Applying one sets data-theme on <html>, writes its properties on <html>, and gives the workspace its Blockly
 * theme and a toolbox with its category styles. The choice is remembered; the first visit follows the computer.
 */
(function () {
    const KEY = 'eaf.theme';
    const themes = new Map();
    const blocklyThemes = new Map();
    let current = null;

    function stored() {
        try {
            return localStorage.getItem(KEY);
        } catch (e) {
            return null;
        }
    }

    function initialName() {
        const saved = stored();
        if (saved && themes.has(saved)) return saved;
        const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
        return dark && themes.has('dark') ? 'dark' : 'light';
    }

    function applyCss(theme) {
        const root = document.documentElement;
        for (const name of Object.keys(themes.get(current)?.css || {})) root.style.removeProperty(name);
        for (const [name, value] of Object.entries(theme.css || {})) root.style.setProperty(name, value);
        root.dataset.theme = theme.name;
        if (theme.outlinedBlocks) root.dataset.outlinedBlocks = 'true';
        else delete root.dataset.outlinedBlocks;
    }

    /** @returns {!Blockly.Theme} */
    function blocklyTheme(name = current) {
        if (!blocklyThemes.has(name)) {
            const theme = themes.get(name);
            blocklyThemes.set(name, Blockly.Theme.defineTheme(`eaf-${name}`, { base: Blockly.Themes.Classic, ...theme.blockly }));
        }
        return blocklyThemes.get(name);
    }

    /** The toolbox with the theme's category styles (in place of the hues) and a class per category for its symbol. */
    function decorateToolbox(config, name = current) {
        const theme = themes.get(name) || {};
        const walk = (node) => {
            if (Array.isArray(node)) return node.map(walk);
            if (!node || typeof node !== 'object') return node;
            const copy = { ...node };
            if (String(copy.kind).toUpperCase() === 'CATEGORY' && copy.name) {
                const key = String(copy.name).toLowerCase();
                copy.cssConfig = { ...(copy.cssConfig || {}), row: `blocklyTreeRow eaf-cat eaf-cat-${key}` };
                if (theme.categoryStyles?.[key]) {
                    copy.categorystyle = theme.categoryStyles[key];
                    delete copy.colour;
                }
            }
            if (copy.contents) copy.contents = walk(copy.contents);
            return copy;
        };
        return walk(config);
    }

    /**
     * @param {string} name
     * @param {{workspace?: ?Blockly.WorkspaceSvg, toolbox?: function(): !Object, remember?: boolean}=} options
     *     toolbox: the current toolbox, before decoration
     */
    function apply(name, { workspace = null, toolbox = null, remember = false } = {}) {
        const theme = themes.get(name);
        if (!theme) return;
        applyCss(theme);
        current = name;
        if (remember) {
            try {
                localStorage.setItem(KEY, name);
            } catch (e) { /* applied, not remembered */ }
        }
        if (workspace && typeof Blockly !== 'undefined') {
            workspace.setTheme(blocklyTheme(name));
            if (toolbox) workspace.updateToolbox(decorateToolbox(toolbox(), name));
        }
        document.dispatchEvent(new CustomEvent('eaf-theme', { detail: { name } }));
    }

    window.eafThemes = {
        register: (theme) => themes.set(theme.name, theme),
        names: () => [...themes.keys()],
        current: () => current,
        initialName,
        blocklyTheme,
        decorateToolbox,
        apply,
    };
})();
