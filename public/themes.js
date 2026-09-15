'use strict';
// The Canvas Suite theme system, ported verbatim from launchcanvas/public/
// themes.js (which carries CrossCanvas's 29 palettes): each theme is a plain
// object of --se-* values applied to :root, grouped the way the suite's
// picker groups them, with per-theme status colors where the defaults would
// clash on light chromes.
//
// ONE DELIBERATE CHANGE: the localStorage key. The suite has real key drift -
// LaunchCanvas still writes 'alertcanvas-theme', so same-host installs share
// one theme setting across apps that look like separate settings. RSCanvas
// has no installed base to disturb, so it takes its own key now and
// MIGRATION-NOTES records that it deliberately does not inherit the suite's.
(function () {
    const THEME_VARS = ['--se-panel', '--se-panel-2', '--se-input', '--se-border',
        '--se-txt', '--se-txt-dim', '--se-accent', '--se-active',
        '--se-up', '--se-down', '--se-warn', '--se-unknown', '--se-series-out',
        '--se-logo-a', '--se-logo-b'];

    // Shared light-chrome status treatment: darker green/red/amber so badges
    // and warn pills keep contrast on pale panels. (--se-warn is an
    // A family addition - warn severity is used here, so the default
    // #d9a92f amber needs a legible light-theme counterpart.)
    const LIGHT_STATUS = { '--se-up': '#1e7a43', '--se-down': '#c23934', '--se-warn': '#9a7415' };

    // Authored in picker order; `group` labels become <optgroup>s.
    const THEMES = {
        classic: { label: 'Classic', vars: {} }, // style.css :root defaults

        // --- Paper ---
        canvas: {
            label: 'Canvas', group: 'Paper',
            vars: { '--se-panel': '#ece5d3', '--se-panel-2': '#e0d7c0', '--se-input': '#f8f4e9',
                    '--se-border': '#c9bda0', '--se-txt': '#3d362a', '--se-txt-dim': '#83795f',
                    '--se-accent': '#8a5a2b', '--se-active': '#8a5a2b',
                    ...LIGHT_STATUS, '--se-series-out': '#4f7a45',
                    '--se-logo-a': '#c49b5f', '--se-logo-b': '#8f6a38' }
        },
        gesso: {
            label: 'Gesso', group: 'Paper',
            vars: { '--se-panel': '#f4f1ea', '--se-panel-2': '#eae6db', '--se-input': '#fbf9f4',
                    '--se-border': '#d8d2c2', '--se-txt': '#45403a', '--se-txt-dim': '#948d7c',
                    '--se-accent': '#b07040', '--se-active': '#96603a',
                    ...LIGHT_STATUS, '--se-series-out': '#5f8a52',
                    '--se-logo-a': '#c9a06a', '--se-logo-b': '#96754a' }
        },
        parchment: {
            label: 'Parchment', group: 'Paper',
            vars: { '--se-panel': '#f0e9dc', '--se-panel-2': '#e6dcc9', '--se-input': '#fffdf8',
                    '--se-border': '#d8cbb2', '--se-txt': '#4a3f2f', '--se-txt-dim': '#7d6f58',
                    '--se-accent': '#b5732e', '--se-active': '#b5732e',
                    ...LIGHT_STATUS, '--se-series-out': '#6b8a3f',
                    '--se-logo-a': '#c99e5e', '--se-logo-b': '#94703f' }
        },
        chalk: {
            label: 'Chalk', group: 'Paper',
            vars: { '--se-panel': '#2b3230', '--se-panel-2': '#353d3a', '--se-input': '#232928',
                    '--se-border': '#45504c', '--se-txt': '#eef0ec', '--se-txt-dim': '#a7b0ab',
                    '--se-accent': '#f7c948', '--se-active': '#d9a92f',
                    '--se-series-out': '#5a8c9e' }
        },
        graphite: {
            label: 'Graphite', group: 'Paper',
            vars: { '--se-panel': '#e8e8ea', '--se-panel-2': '#dcdce0', '--se-input': '#f6f6f7',
                    '--se-border': '#c4c4c9', '--se-txt': '#3a3a3e', '--se-txt-dim': '#86868c',
                    '--se-accent': '#5a5a62', '--se-active': '#46464c',
                    ...LIGHT_STATUS, '--se-series-out': '#8a8a92' }
        },
        mono: {
            label: 'Mono', group: 'Paper',
            vars: { '--se-panel': '#efefef', '--se-panel-2': '#e4e4e4', '--se-input': '#fafafa',
                    '--se-border': '#cccccc', '--se-txt': '#222222', '--se-txt-dim': '#777777',
                    '--se-accent': '#333333', '--se-active': '#000000',
                    ...LIGHT_STATUS, '--se-series-out': '#888888' }
        },

        // --- Warm ---
        garnet: {
            label: 'Garnet', group: 'Warm',
            vars: { '--se-panel': '#33141d', '--se-panel-2': '#401a25', '--se-input': '#240d14',
                    '--se-border': '#592433', '--se-txt': '#f2e6e9', '--se-txt-dim': '#c39aa5',
                    '--se-accent': '#d9556e', '--se-active': '#a52238',
                    '--se-series-out': '#dcae4a', '--se-down': '#ff7a45' }
        },
        ember: {
            label: 'Ember', group: 'Warm',
            vars: { '--se-panel': '#1a1a1c', '--se-panel-2': '#242427', '--se-input': '#101012',
                    '--se-border': '#3a3a3e', '--se-txt': '#ecebe9', '--se-txt-dim': '#a09d99',
                    '--se-accent': '#ff8c1a', '--se-active': '#d97528',
                    '--se-series-out': '#7fb26a' }
        },
        rose: {
            label: 'Rose', group: 'Warm',
            vars: { '--se-panel': '#2e2129', '--se-panel-2': '#3b2b35', '--se-input': '#211820',
                    '--se-border': '#4d3a45', '--se-txt': '#f2e8ee', '--se-txt-dim': '#c3a3b4',
                    '--se-accent': '#e08aa4', '--se-active': '#c25f7f',
                    '--se-series-out': '#96b489' }
        },
        sakura: {
            label: 'Sakura', group: 'Warm',
            vars: { '--se-panel': '#fbeef2', '--se-panel-2': '#f6e0e8', '--se-input': '#fef8fa',
                    '--se-border': '#eecdd8', '--se-txt': '#4a3540', '--se-txt-dim': '#9a7c88',
                    '--se-accent': '#e58aab', '--se-active': '#d06b90',
                    '--se-up': '#2f8a4d', '--se-down': '#c23934',
                    '--se-unknown': '#9a8a92', '--se-series-out': '#6aa06a' }
        },
        retro: {   // Gruvbox
            label: 'Retro', group: 'Warm',
            vars: { '--se-panel': '#282828', '--se-panel-2': '#3c3836', '--se-input': '#1d2021',
                    '--se-border': '#504945', '--se-txt': '#ebdbb2', '--se-txt-dim': '#a89984',
                    '--se-accent': '#fe8019', '--se-active': '#d65d0e',
                    '--se-series-out': '#b8bb26', '--se-up': '#98971a', '--se-down': '#fb4934' }
        },

        // --- Cool ---
        blueprint: {
            label: 'Blueprint', group: 'Cool',
            vars: { '--se-panel': '#142c47', '--se-panel-2': '#1a3a5c', '--se-input': '#0e2136',
                    '--se-border': '#2a4d73', '--se-txt': '#dfe9f5', '--se-txt-dim': '#93aecb',
                    '--se-accent': '#7fd4ff', '--se-active': '#2e6da4',
                    '--se-series-out': '#6be59a', '--se-logo-a': '#dcc296', '--se-logo-b': '#b3945f' }
        },
        sage: {
            label: 'Sage', group: 'Cool',
            vars: { '--se-panel': '#e4ebe1', '--se-panel-2': '#d6e0d1', '--se-input': '#fbfdfa',
                    '--se-border': '#c0cdba', '--se-txt': '#2f3a2e', '--se-txt-dim': '#5f6d5b',
                    '--se-accent': '#5b8c4f', '--se-active': '#4e7a44',
                    ...LIGHT_STATUS, '--se-series-out': '#b5732e' }
        },
        evergreen: {
            label: 'Evergreen', group: 'Cool',
            vars: { '--se-panel': '#173726', '--se-panel-2': '#1f4a33', '--se-input': '#10281c',
                    '--se-border': '#2c5c40', '--se-txt': '#e7efe9', '--se-txt-dim': '#9db8a7',
                    '--se-accent': '#58b380', '--se-active': '#2d7a4f',
                    '--se-series-out': '#d9c34f' }
        },
        lagoon: {
            label: 'Lagoon', group: 'Cool',
            vars: { '--se-panel': '#0f3a38', '--se-panel-2': '#144a47', '--se-input': '#0a2827',
                    '--se-border': '#1f5c58', '--se-txt': '#e4efee', '--se-txt-dim': '#93b5b2',
                    '--se-accent': '#2dd4bf', '--se-active': '#0f766e',
                    '--se-series-out': '#c9814e' }
        },
        glacier: {
            label: 'Glacier', group: 'Cool',
            vars: { '--se-panel': '#e9edf2', '--se-panel-2': '#dbe1ea', '--se-input': '#ffffff',
                    '--se-border': '#c3ccd8', '--se-txt': '#1f2a37', '--se-txt-dim': '#5c6672',
                    '--se-accent': '#2f6fd0', '--se-active': '#2f6fd0',
                    ...LIGHT_STATUS, '--se-series-out': '#1e7a43' }
        },
        slate: {
            label: 'Slate', group: 'Cool',
            vars: { '--se-panel': '#23272b', '--se-panel-2': '#2c3136', '--se-input': '#17191c',
                    '--se-border': '#3d4349', '--se-txt': '#e8eaec', '--se-txt-dim': '#9aa1a8',
                    '--se-accent': '#7d97ad', '--se-active': '#546a7e' }
        },
        storm: {
            label: 'Storm', group: 'Cool',
            vars: { '--se-panel': '#1e2530', '--se-panel-2': '#28313f', '--se-input': '#161c25',
                    '--se-border': '#37414f', '--se-txt': '#d5dce6', '--se-txt-dim': '#8593a5',
                    '--se-accent': '#6fa8dc', '--se-active': '#4a80b8' }
        },
        arctic: {   // Nord
            label: 'Arctic', group: 'Cool',
            vars: { '--se-panel': '#2e3440', '--se-panel-2': '#3b4252', '--se-input': '#272c36',
                    '--se-border': '#434c5e', '--se-txt': '#eceff4', '--se-txt-dim': '#9aa5b8',
                    '--se-accent': '#88c0d0', '--se-active': '#5e81ac',
                    '--se-series-out': '#a3be8c' }
        },
        solarLight: {   // Solarized cream
            label: 'Solar Light', group: 'Cool',
            vars: { '--se-panel': '#eee8d5', '--se-panel-2': '#e3dcc4', '--se-input': '#fdf6e3',
                    '--se-border': '#cfc8b0', '--se-txt': '#586e75', '--se-txt-dim': '#93a1a1',
                    '--se-accent': '#268bd2', '--se-active': '#2aa198',
                    '--se-up': '#859900', '--se-down': '#dc322f', '--se-series-out': '#859900' }
        },

        // --- Night ---
        ink: {
            label: 'Ink', group: 'Night',
            vars: { '--se-panel': '#211d1a', '--se-panel-2': '#2a2521', '--se-input': '#161311',
                    '--se-border': '#3d362f', '--se-txt': '#ede7dc', '--se-txt-dim': '#a89e8f',
                    '--se-accent': '#c98f4e', '--se-active': '#96683a',
                    '--se-series-out': '#8aab6d', '--se-logo-a': '#d3a866', '--se-logo-b': '#9c7847' }
        },
        midnight: {
            label: 'Midnight', group: 'Night',
            vars: { '--se-panel': '#1e1b3a', '--se-panel-2': '#272248', '--se-input': '#141126',
                    '--se-border': '#383163', '--se-txt': '#eae8f4', '--se-txt-dim': '#a29cc4',
                    '--se-accent': '#8b7cf8', '--se-active': '#5b4bc4',
                    '--se-series-out': '#4fc9a8' }
        },
        crimsonNavy: {
            label: 'Crimson Navy', group: 'Night',
            vars: { '--se-panel': '#152a52', '--se-panel-2': '#1c3766', '--se-input': '#0e1d3a',
                    '--se-border': '#2a4576', '--se-txt': '#e8ecf5', '--se-txt-dim': '#9fadc9',
                    '--se-accent': '#dc2743', '--se-active': '#dc2743',
                    '--se-series-out': '#3dbf9a', '--se-down': '#ff7a45' }
        },
        synthwave: {
            label: 'Synthwave', group: 'Night',
            vars: { '--se-panel': '#1a1030', '--se-panel-2': '#251643', '--se-input': '#120a24',
                    '--se-border': '#3a2560', '--se-txt': '#ece6ff', '--se-txt-dim': '#a596c9',
                    '--se-accent': '#ff4d8d', '--se-active': '#d6337a',
                    '--se-series-out': '#36d6e7', '--se-up': '#39e58c' }
        },
        nocturne: {   // Dracula
            label: 'Nocturne', group: 'Night',
            vars: { '--se-panel': '#282a36', '--se-panel-2': '#343746', '--se-input': '#1e1f29',
                    '--se-border': '#44475a', '--se-txt': '#f8f8f2', '--se-txt-dim': '#a3a9c9',
                    '--se-accent': '#bd93f9', '--se-active': '#ff79c6',
                    '--se-series-out': '#50fa7b' }
        },
        tokyoNight: {
            label: 'Tokyo Night', group: 'Night',
            vars: { '--se-panel': '#1a1b26', '--se-panel-2': '#24283b', '--se-input': '#16161e',
                    '--se-border': '#2f334d', '--se-txt': '#c0caf5', '--se-txt-dim': '#7f88b3',
                    '--se-accent': '#7aa2f7', '--se-active': '#bb9af7',
                    '--se-series-out': '#9ece6a' }
        },
        solarDark: {   // Solarized dark
            label: 'Solar Dark', group: 'Night',
            vars: { '--se-panel': '#002b36', '--se-panel-2': '#073642', '--se-input': '#00212b',
                    '--se-border': '#0d4a58', '--se-txt': '#93a1a1', '--se-txt-dim': '#5f7883',
                    '--se-accent': '#2aa198', '--se-active': '#268bd2',
                    '--se-up': '#859900', '--se-down': '#dc322f', '--se-series-out': '#b58900' }
        },

        // --- Screen ---
        phosphor: {
            label: 'Phosphor', group: 'Screen',
            vars: { '--se-panel': '#0d1a0d', '--se-panel-2': '#12240f', '--se-input': '#071007',
                    '--se-border': '#1e3a1a', '--se-txt': '#a8f0a0', '--se-txt-dim': '#5c9e57',
                    '--se-accent': '#39ff14', '--se-active': '#2bcc10',
                    '--se-up': '#39ff14', '--se-down': '#ff5544', '--se-series-out': '#c8f04f' }
        },
        amber: {
            label: 'Amber', group: 'Screen',
            vars: { '--se-panel': '#1a1206', '--se-panel-2': '#241a0a', '--se-input': '#100b04',
                    '--se-border': '#3a2a12', '--se-txt': '#ffcc66', '--se-txt-dim': '#a8813c',
                    '--se-accent': '#ffb000', '--se-active': '#cc8c00',
                    '--se-up': '#ffb000', '--se-down': '#ff5544', '--se-series-out': '#e07b39' }
        }
    };

    const KEY = 'rscanvas-theme';   // deliberately NOT the suite's key - see header

    function applyTheme(name) {
        const theme = THEMES[name] || THEMES.classic;
        const root = document.documentElement.style;
        for (const v of THEME_VARS) root.removeProperty(v);
        for (const [k, val] of Object.entries(theme.vars)) root.setProperty(k, val);
        try { localStorage.setItem(KEY, name); } catch (_) { /* private mode */ }
    }

    function currentTheme() {
        try { return localStorage.getItem(KEY) || 'classic'; } catch (_) { return 'classic'; }
    }

    // Build the grouped picker options, restore the saved choice, apply on
    // change. Shared by the app and the static docs pages so the option-group
    // loop exists exactly once.
    function wirePicker(select) {
        if (!select) return;
        let optgroup = null;
        for (const [key, t] of Object.entries(THEMES)) {
            const o = document.createElement('option');
            o.value = key; o.textContent = t.label;
            if (!t.group) {
                select.appendChild(o);
            } else {
                if (!optgroup || optgroup.label !== t.group) {
                    optgroup = document.createElement('optgroup');
                    optgroup.label = t.group;
                    select.appendChild(optgroup);
                }
                optgroup.appendChild(o);
            }
        }
        select.value = currentTheme();
        select.addEventListener('change', () => applyTheme(select.value));
    }

    window.Themes = { THEMES, applyTheme, currentTheme, wirePicker };
    applyTheme(currentTheme());
})();
