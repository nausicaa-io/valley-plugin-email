const CSS = `

.email-panel,.email-page { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; color:var(--text-color); }
.email-panel { container:email-panel / inline-size; }
.email-page { container:email-page / inline-size; background:var(--pane-bg); }
.email-panel .panel-header { gap:6px; }
.email-panel .panel-title { flex:0 0 auto; }
.email-panel-body { display:flex; flex-direction:column; min-height:0; padding:0; overflow:hidden; }
.email-panel-body > .email-notice { margin:8px; }
.email-empty { padding:20px 12px; color:var(--text-secondary); font-size:.8125rem; line-height:1.5; }
.email-empty-account { display:flex; flex-direction:column; gap:12px; align-items:flex-start; }
.email-icon-btn { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; flex:0 0 26px; padding:0; border:0; border-radius:5px; background:none; color:var(--text-secondary); cursor:pointer; -webkit-app-region:no-drag; }
.email-icon-btn:hover:not(:disabled),.email-selector:hover:not(:disabled) { background:var(--hover-bg); color:var(--title-color); }
.email-icon-btn:disabled,.email-selector:disabled { opacity:.4; cursor:default; }
.email-icon-btn svg { width:15px; height:15px; }
.email-compose-action { color:var(--accent-color); }
.email-mailbox-controls { display:flex; gap:3px; align-items:center; min-width:0; -webkit-app-region:no-drag; }
.email-mailbox-controls.compact { flex:1; justify-content:flex-end; }
.email-selector { display:flex; align-items:center; gap:5px; min-width:0; max-width:170px; height:26px; padding:0 6px; background:none; border:0; border-radius:5px; color:var(--text-color); font:inherit; font-size:.75rem; cursor:pointer; }
.email-selector span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.email-selector svg { width:14px; height:14px; flex:none; }
.email-selector > svg:last-child { width:10px; }
.email-mailbox-controls.compact .email-account-selector { padding:0 4px; flex:0 0 26px; }
.email-mailbox-controls.compact .email-account-selector span,.email-mailbox-controls.compact .email-account-selector > svg:last-child { display:none; }
.email-mailbox-controls.compact .email-selector { max-width:110px; }
.email-toolbar { --email-toolbar-action-space:210px; position:relative; display:flex; align-items:center; gap:6px; height:var(--app-bar-height); min-height:var(--app-bar-height); box-sizing:border-box; padding:0 calc(var(--plugin-actions-offset, 0px) + 8px) 0 calc(var(--plugin-navigation-offset, 0px) + 8px); border-bottom:1px solid var(--border-light); background:var(--pane-bg); }
.email-toolbar-title { position:absolute; left:50%; top:calc(var(--app-bar-height) / 2); transform:translate(-50%,-50%); max-width:max(0px,calc(100% - 2 * max(calc(var(--plugin-navigation-offset, 0px) + 8px),calc(var(--plugin-actions-offset, 0px) + var(--email-toolbar-action-space))))); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center; color:var(--title-color); font:600 .8125rem/1.4 var(--body-font); }
.email-toolbar > .email-mailbox-controls { flex:1; }
.email-toolbar > .email-message-actions { margin-left:auto; }
.email-message-actions { display:flex; align-items:center; flex:none; }
.email-action-group { display:flex; gap:2px; align-items:center; }
.email-action-group + .email-action-group { border-left:1px solid var(--border-light); margin-left:8px; padding-left:8px; }
.email-icon-btn.email-flagged { color:#e6a817; }
.email-reload[aria-busy="true"] svg { animation:email-reload-spin 1s linear infinite; }
@keyframes email-reload-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) { .email-reload[aria-busy="true"] svg { animation:none; } }
.email-panel-body > .email-search { width:auto; margin:var(--space-2) var(--space-1) 0; flex:none; }
.email-list-status { display:flex; justify-content:space-between; flex:none; padding:7px 12px; color:var(--text-secondary); font-size:.6875rem; }
.email-message-list { flex:1; min-height:0; overflow:auto; }
.email-message-row { display:flex; align-items:flex-start; gap:9px; min-height:82px; box-sizing:border-box; padding:10px; background:var(--container-color); }
.email-message-copy { min-width:0; flex:1; }
.email-message-top { display:flex; gap:8px; align-items:baseline; }
.email-message-top strong { min-width:0; flex:1; font-size:.8125rem; font-weight:550; color:var(--title-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.email-message-top time { flex:none; white-space:nowrap; font-size:.65625rem; font-variant-numeric:tabular-nums; color:var(--text-secondary); }
.email-message-subject,.email-message-snippet { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.5; }
.email-message-subject { font-size:.75rem; color:var(--text-color); }
.email-message-snippet { font-size:.71875rem; color:var(--text-secondary); }
.email-message-avatar { position:relative; display:block; width:32px; height:32px; flex:0 0 32px; }
.email-message-avatar > .email-avatar { width:32px; height:32px; }
.email-message-avatar.unread::after { content:''; position:absolute; top:-1px; right:-1px; width:7px; height:7px; border:2px solid var(--container-color); border-radius:50%; background:var(--accent-color); }
.email-message-row.unread .email-message-top strong,.email-message-row.unread .email-message-subject { font-weight:700; color:var(--title-color); }
.email-message-badges { display:flex; flex-direction:column; gap:5px; width:13px; flex:0 0 13px; margin-top:4px; color:var(--accent-color); }
.email-message-badges svg { width:12px; height:12px; }
.email-avatar { display:block; width:28px; height:28px; border-radius:50%; object-fit:cover; flex:none; }
.email-avatar-initials { display:grid; place-items:center; box-sizing:border-box; background:#8f969f; color:#fff; font:650 .71875rem/1 var(--body-font); letter-spacing:.02em; text-transform:uppercase; }
.email-swipe-row { position:relative; overflow:hidden; border-bottom:1px solid var(--border-light); background:var(--container-color); }
.email-swipe-content { position:relative; z-index:1; cursor:pointer; touch-action:pan-y; background:var(--container-color); transition:transform 150ms ease-out; }
.email-swipe-content:active { transition:none; }
.email-swipe-content:hover .email-message-row { background:color-mix(in srgb,var(--text-color) 6%,var(--container-color)); }
.email-swipe-row.active .email-message-row { background:color-mix(in srgb,var(--accent-color) 15%,var(--container-color)); }
.email-swipe-content:focus-visible { outline:2px solid var(--accent-color); outline-offset:-2px; }
.email-swipe-tray { position:absolute; top:0; bottom:0; width:0; visibility:hidden; pointer-events:none; overflow:hidden; display:flex; }
.email-swipe-tray.leading { left:0; }
.email-swipe-tray.trailing { right:0; }
.email-swipe-row[data-side="leading"] .email-swipe-tray.leading,.email-swipe-row[data-side="trailing"] .email-swipe-tray.trailing { width:116px; visibility:visible; pointer-events:auto; }
.email-swipe-tray button { flex:0 0 58px; width:58px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; border:0; padding:3px; background:none; color:white; cursor:pointer; font:inherit; font-size:.59375rem; }
.email-swipe-tray button.email-swipe-read { background:var(--accent-color); }
.email-swipe-tray button.email-swipe-archive { background:#6b7280; }
.email-swipe-tray button.email-swipe-flag { background:#94601c; }
.email-swipe-tray button.danger { background:#ad3645; }
.email-swipe-tray button:disabled { opacity:.45; cursor:default; }
.email-swipe-tray svg { width:16px; height:16px; }
.email-load-more { width:100%; padding:12px; background:none; border:0; color:var(--accent-color); font:inherit; font-size:.75rem; cursor:pointer; }
.email-account-popover,.email-contact-card { width:280px; max-width:calc(100vw - 30px); max-height:65vh; overflow:auto; padding:6px; }
.email-popover-label { padding:7px 8px; font-size:.75rem; font-weight:600; color:var(--text-secondary); overflow-wrap:anywhere; }
.email-popover-separator { height:1px; margin:5px 2px; background:var(--border-light); }
.email-account-option { width:100%; display:flex; align-items:center; gap:8px; min-height:32px; padding:6px 8px; border:0; border-radius:5px; background:none; color:var(--text-color); font:inherit; font-size:.8125rem; text-align:left; cursor:pointer; }
.email-account-option:hover { background:var(--hover-bg); }
.email-account-option.selected { background:var(--accent-tint-bg); }
.email-account-option > svg { width:15px; height:15px; flex:none; }
.email-account-check { width:14px; flex:none; color:var(--accent-color); }
.email-account-copy { display:flex; flex-direction:column; min-width:0; flex:1; }
.email-account-copy strong { font-size:.8125rem; color:var(--title-color); font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.email-account-copy small { font-size:.71875rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.email-account-picker { padding:6px; }
.email-account-picker-head { display:flex; align-items:center; justify-content:space-between; min-height:28px; padding:0 8px 5px; border-bottom:1px solid var(--border-light); }
.email-account-picker-title,.email-account-picker-all { padding:2px 4px; border:0; border-radius:5px; background:none; font:inherit; font-size:.75rem; }
.email-account-picker-title { color:var(--accent-color); font-weight:600; }
.email-account-picker-all { color:var(--text-tertiary); cursor:pointer; }
.email-account-picker-all:hover { background:var(--hover-bg); color:var(--title-color); }
.email-account-picker-list { display:flex; flex-direction:column; padding-top:4px; }
.email-account-picker-option { display:flex; align-items:center; gap:8px; width:100%; min-height:32px; padding:6px 8px; border:0; border-radius:5px; background:none; color:var(--text-color); font:inherit; font-size:.8125rem; text-align:left; cursor:pointer; }
.email-account-picker-option:hover,.email-account-picker-option.active { background:var(--hover-bg); color:var(--title-color); }
.email-account-picker-option.active { border-radius:0; }
.email-account-picker-option.active.selection-run-start { border-top-left-radius:5px; border-top-right-radius:5px; }
.email-account-picker-option.active.selection-run-end { border-bottom-right-radius:5px; border-bottom-left-radius:5px; }
.email-account-picker-option.active:hover { background:color-mix(in srgb,var(--title-color) 14%,transparent); }
.email-account-picker-option.active:has(+ .email-account-picker-option:hover),.email-account-picker-option:hover:has(+ .email-account-picker-option.active) { border-bottom-right-radius:0; border-bottom-left-radius:0; }
.email-account-picker-option.active + .email-account-picker-option:hover,.email-account-picker-option:hover + .email-account-picker-option.active { border-top-left-radius:0; border-top-right-radius:0; }
.email-row-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.email-reader { flex:1; min-height:0; overflow:auto; padding:0 0 50px; }
.email-reader-inner { max-width:none; }
.email-reader-header { display:grid; grid-template-columns:44px minmax(0,1fr); column-gap:16px; row-gap:18px; align-items:start; padding:30px 32px 24px; border-bottom:1px solid var(--border-light); }
.email-reader-avatar { display:block; width:44px; height:44px; }
.email-reader-avatar > .email-avatar { width:44px; height:44px; }
.email-reader-avatar > .email-avatar-initials { background:#8f969f; color:#fff; font-size:1rem; font-weight:650; text-transform:uppercase; }
.email-reader-summary { min-width:0; }
.email-reader-subject { margin:0 0 16px; color:var(--title-color); font:650 1.5rem/1.3 var(--body-font); overflow-wrap:anywhere; }
.email-reader-addresses { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:5px 12px; margin:0; font-size:.8125rem; line-height:1.55; }
.email-reader-meta { display:contents; }
.email-reader-meta dt { color:var(--text-secondary); font-weight:400; }
.email-reader-meta dd { min-width:0; margin:0; color:var(--text-color); overflow-wrap:anywhere; }
.email-reader-context { grid-column:1 / -1; display:flex; align-items:center; justify-content:flex-end; min-width:0; border-top:1px solid var(--border-light); padding-top:12px; color:var(--text-secondary); font-size:.75rem; }
.email-reader-date { display:block; margin:0; white-space:nowrap; color:var(--text-secondary); font-size:.75rem; font-variant-numeric:tabular-nums; }
.email-reader-body { max-width:820px; margin:32px auto 0; padding:0 32px; font:400 .9375rem/1.7 var(--body-font); color:var(--text-color); white-space:pre-wrap; overflow-wrap:anywhere; }
.email-body-options { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:12px; white-space:normal; font-size:.71875rem; color:var(--text-secondary); }
.email-html-body { display:block; width:100%; box-sizing:border-box; border:0; border-radius:0; background:white; }
.email-person { display:inline-flex; flex-wrap:wrap; gap:3px 6px; align-items:baseline; font:inherit; color:inherit; max-width:100%; overflow-wrap:anywhere; }
button.email-person { border:0; padding:0; background:none; text-align:left; cursor:pointer; }
.email-person.linked > span { color:var(--accent-color); }
.email-person.linked:hover > span { text-decoration:underline; }
.email-person small { color:var(--text-secondary); font-size:.75rem; }
.email-placeholder { display:grid; place-items:center; flex:1; min-height:0; padding:24px; color:var(--text-secondary); text-align:center; }
.email-placeholder-content { display:flex; flex-direction:column; align-items:center; max-width:280px; }
.email-placeholder-icon { display:grid; place-items:center; margin-bottom:12px; color:var(--title-color); opacity:.55; }
.email-placeholder-icon svg { width:32px; height:32px; }
.email-placeholder-title { margin:0; color:var(--text-secondary); font:400 .8125rem/1.45 var(--body-font); }
.email-placeholder-action { min-height:30px; margin-top:8px; padding:5px 10px; }
.email-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:6px 12px; font:inherit; font-size:.75rem; font-weight:550; cursor:pointer; border-radius:6px; border:1px solid var(--border-light); background:var(--container-color-light); color:var(--text-color); }
.email-btn svg { width:15px; height:15px; }
.email-btn:hover:not(:disabled) { background:var(--hover-bg); }
.email-btn.primary { background:var(--accent-color); color:white; border-color:var(--accent-color); }
.email-btn:disabled { opacity:.4; cursor:default; }
.email-form { flex:1; min-height:0; overflow:auto; padding:24px 30px; display:flex; flex-direction:column; gap:0; }
.email-compose-header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
.email-form h2 { margin:0; color:var(--title-color); font-size:1.2rem; }
.email-recipient-field,.email-compose-subject { display:flex; align-items:baseline; gap:12px; padding:10px 0; border-bottom:1px solid var(--border-light); }
.email-field-label { width:60px; flex:0 0 60px; color:var(--text-secondary); font-size:.8125rem; }
.email-recipient-chips { display:flex; flex-wrap:wrap; gap:5px; flex:1; min-width:0; align-items:center; }
.email-recipient-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%; border-radius:5px; padding:3px 6px; background:var(--container-color-light); font-size:.8125rem; }
.email-recipient-chip > button { border:0; background:none; color:var(--text-secondary); cursor:pointer; }
.email-recipient-add { min-width:120px; max-width:100%; border:0; background:none; padding:4px 0; font:inherit; font-size:.8125rem; color:var(--text-secondary); text-align:left; cursor:text; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.email-recipient-popover { padding:10px; width:340px; max-width:calc(100vw - 32px); }
.email-recipient-results { max-height:250px; overflow:auto; margin:6px 0; }
.email-recipient-error { color:var(--negative-color); padding:8px 0; font-size:.75rem; }
.email-compose-subject input { flex:1; min-width:0; font:inherit; font-size:.875rem; border:0; outline:0; background:none; color:var(--text-color); }
.email-compose-body { flex:1; min-height:220px; resize:none; padding:20px 0; border:0; outline:0; background:none; color:var(--text-color); font:400 .9375rem/1.65 var(--body-font); }
.email-form-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
.email-preview { padding:14px 15px; overflow:auto; height:100%; font-size:.8125rem; }
.email-preview-subject { margin:0 0 10px; color:var(--title-color); font-size:1rem; }
.email-preview-meta { color:var(--text-secondary); margin-bottom:5px; font-size:.75rem; overflow-wrap:anywhere; }
.email-preview-body { margin-top:16px; padding-top:16px; border-top:1px solid var(--border-light); white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.65; }
@container email-page (max-width:700px) {
 .email-toolbar { --email-toolbar-action-space:8px; height:calc(2 * var(--app-bar-height)); min-height:calc(2 * var(--app-bar-height)); }
 .email-toolbar > .email-message-actions { position:absolute; right:8px; bottom:calc((var(--app-bar-height) - 26px) / 2); margin-left:0; }
 .email-reader { padding:0 0 32px; }
 .email-reader-header { column-gap:14px; row-gap:16px; padding:26px 22px 22px; }
 .email-reader-subject { font-size:1.375rem; }
 .email-reader-body { margin-top:24px; padding:0 22px; }
 .email-reader.html .email-body-options { padding-left:22px; padding-right:22px; }
}
@container email-page (max-width:480px) {
 .email-account-selector span { display:none; }
 .email-toolbar .email-sync { display:none; }
 .email-reader { padding:0 0 24px; }
 .email-reader-header { grid-template-columns:44px minmax(0,1fr); column-gap:12px; row-gap:14px; padding:24px 18px 20px; }
 .email-reader-avatar,.email-reader-avatar > .email-avatar { width:44px; height:44px; }
 .email-reader-avatar > .email-avatar-initials { font-size:.875rem; }
 .email-reader-summary { display:contents; }
 .email-reader-subject { grid-column:2; margin:0; font-size:1.25rem; }
 .email-reader-addresses { grid-column:1 / -1; }
 .email-reader-body { margin-top:18px; padding:0 18px; }
 .email-reader.html .email-body-options { padding-left:18px; padding-right:18px; }
 .email-form { padding:18px; }
 .email-compose-header { align-items:flex-start; flex-direction:column; gap:10px; }
 .email-form-actions { justify-content:flex-start; }
 .email-selector { max-width:110px; }
}
@container email-page (max-width:320px) {
 .email-toolbar { gap:3px; }
 .email-toolbar .email-selector { flex:0 0 26px; padding:0 5px; }
 .email-toolbar .email-selector span,.email-toolbar .email-selector > svg:last-child,.email-toolbar .email-reveal-sidebar { display:none; }
 .email-reader-header { grid-template-columns:36px minmax(0,1fr); gap:8px; }
 .email-reader-avatar,.email-reader-avatar > .email-avatar { width:36px; height:36px; }
}
.email-notice { display:flex; gap:8px; padding:8px 9px; border-radius:var(--radius-sm);
  border:1px solid color-mix(in srgb, var(--negative-color) 32%, transparent);
  background:color-mix(in srgb, var(--negative-color) 9%, transparent); }
.email-notice-glyph { flex:0 0 auto; margin-top:1px; color:var(--negative-color); }
.email-notice-glyph svg { display:block; width:14px; height:14px; }
.email-notice-body { display:flex; flex-direction:column; gap:2px; min-width:0; }
.email-notice-title { font-size:0.75rem; font-weight:600; color:var(--text-color); }
.email-notice-detail { font-size:0.71875rem; line-height:1.45; color:var(--text-secondary); overflow-wrap:anywhere; }
.email-notice-actions { display:flex; gap:12px; margin-top:5px; }
.email-notice-btn { padding:0; border:none; background:none; cursor:pointer; font:inherit;
  font-size:0.71875rem; font-weight:600; color:var(--accent-color); }
.email-notice-btn:hover { text-decoration:underline; }
.email-notice-btn.subtle { color:var(--text-tertiary); font-weight:500; }
.email-notice-btn.subtle:hover { color:var(--text-secondary); }
.email-notice-slot { padding:10px 16px 0; }

.email-reader.html .email-reader-body { max-width:none; margin:0; padding:0; }
.email-reader.html .email-body-options { margin:24px 0 12px; padding:0 64px; }

.email-settings-empty { margin:0; padding:10px 2px; font-size:0.8125rem; color:var(--text-secondary); line-height:1.5; }
.email-glyph-mail { width:18px; height:18px; }
.email-badge { display:inline-flex; align-items:center; gap:6px; flex:none; font-size:0.6875rem; padding:2px 9px;
  border-radius:999px; border:1px solid var(--border-medium, rgba(128,128,128,.3)); color:var(--text-secondary);
  white-space:nowrap; }
.email-dot { width:6px; height:6px; flex:0 0 auto; border-radius:50%; }
.email-dot.ok { background:#2fab53; }
.email-dot.off { background:#e5484d; }
.email-badge.ok { background:var(--accent-tint-bg); color:var(--accent-tint-text); border-color:transparent; }
.email-badge.off { background:var(--container-color-alt, rgba(128,128,128,.08)); }
.email-reauth { display:flex; align-items:center; flex:none; font-size:0.75rem; color:#ff453a; }
.email-detail-identity { display:flex; align-items:center; gap:12px; padding-bottom:12px;
  border-bottom:1px solid var(--border-light, rgba(128,128,128,.18)); }

.email-preview-title-row { display:flex; align-items:flex-start; gap:8px; }
.email-preview-title-row h3 { flex:1; }
.email-preview-title-row > svg { color:#e39b21; width:15px; height:15px; }
.email-preview-overview { text-align:center; }
.email-preview-overview h3 { margin:8px 0 2px; font-size:.9375rem; }
.email-preview-overview > p { margin:0; color:var(--text-tertiary); font-size:.6875rem; overflow-wrap:anywhere; }
.email-preview-glyph { display:grid; place-items:center; width:38px; height:38px; margin:5px auto 0; border-radius:10px;
  background:var(--accent-tint-bg); color:var(--accent-color); }
.email-overview-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin-top:16px; }
.email-overview-stats > div { display:flex; flex-direction:column; gap:2px; padding:8px 4px; border-radius:7px; background:var(--container-color-light); }
.email-overview-stats strong { font-size:.875rem; }
.email-overview-stats span { color:var(--text-tertiary); font-size:.59375rem; }
.email-property-lines { white-space:pre-line; overflow-wrap:anywhere; }
.email-properties .email-property-toggle { align-items:center; }
.email-properties .email-property-toggle .props-info-value { display:flex; justify-content:flex-end; }
.email-property-people { display:flex; flex-direction:column; gap:8px; }
.email-property-person { display:flex; flex-direction:column; gap:2px; min-width:0; line-height:1.4; }
.email-property-name { font-weight:500; color:var(--title-color); }
.email-property-person small { font-size:var(--smaller-font-size); overflow-wrap:anywhere; }
.email-meta { padding:10px 12px 18px; }
.email-meta-section + .email-meta-section { margin-top:16px; }
.email-meta-section h4 { margin:0 0 7px; color:var(--text-tertiary); font-size:.65625rem; text-transform:uppercase; letter-spacing:.045em; }
.email-meta-fact { display:grid; grid-template-columns:minmax(70px, .8fr) minmax(0, 1.2fr); gap:10px; padding:4px 0; font-size:.71875rem; line-height:1.35; }
.email-meta-fact > span { color:var(--text-tertiary); }
.email-meta-fact > strong { min-width:0; color:var(--text-secondary); font-weight:500; overflow-wrap:anywhere; }
.email-meta-placeholder { min-height:140px; height:auto; }

`

export function injectStyles(): () => void {
  const id = 'notes-email-plugin-styles'
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = CSS
  return () => {
    if (document.getElementById(id) === el) el.remove()
  }
}
