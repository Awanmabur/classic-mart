import assert from 'node:assert/strict';

// Preserve the frozen reference byte-for-byte, except explicitly enumerated
// user-approved changes: retired toasts, transparent mobile overlay, restored
// brand colours, and the checkout security icon. Reject all other drift.
export function approvedAssetWithSharedFlash(name, reference) {
  let expected = Buffer.from(reference);
  if (name === 'styles.css' || name === 'design-system.css') {
    const retired = name === 'styles.css'
      ? /\n\.toast \{[^{}]*\n\}\n\n\.toast\.show \{[^{}]*\n\}\n/g
      : /\n\.toast \{[^{}]*\n\}\n/g;
    const source = expected.toString('utf8');
    assert.equal([...source.matchAll(retired)].length, 1, `${name}: exactly one frozen notification block`);
    expected = Buffer.from(source.replace(retired, '\n'));
    if (name === 'styles.css') {
      // These exact already-deployed user-approved deltas are distinct from the
      // frozen preview: transparent mobile overlay, restored brand palette,
      // and the checkout security icon. Reject every other design change.
      const approvedDeltas = [
        [
          '  .sidebar-overlay.show {\n    display: block;\n',
          '  /* Keep outside-tap dismissal functional without dimming the phone screen. */\n  .sidebar-overlay.show {\n    display: block;\n    background: transparent;\n    box-shadow: none;\n    backdrop-filter: none;\n    -webkit-backdrop-filter: none;\n',
        ],
        [
          '.deal-badge { position: absolute; top: 12px; left: 12px; z-index: 2; padding: 5px 9px; color: #16863b; background: #e4f7e9; border-radius: 999px; font-size: 11px; font-weight: 600; }',
          '.deal-badge { position: absolute; top: 12px; left: 12px; z-index: 2; padding: 5px 9px; color: var(--blue-dark); background: var(--blue-soft); border-radius: 999px; font-size: 11px; font-weight: 600; }',
        ],
        [
          '.free-text { color: #16863b; }',
          '.free-text { color: var(--blue); }',
        ],
        [
          '.secure-checkout { margin-top: 13px; justify-content: center; color: var(--muted); font-size: 11px; }',
          '.secure-checkout { margin-top: 13px; justify-content: center; color: var(--muted); font-size: 11px; }\n.cart-layout .secure-checkout svg { color: var(--blue); }',
        ],
      ];
      let approved = expected.toString('utf8');
      for (const [frozen, published] of approvedDeltas) {
        assert.equal(approved.split(frozen).length, 2, 'Expected a single frozen approved-style anchor');
        approved = approved.replace(frozen, published);
      }
      expected = Buffer.from(approved);
    }
  } else if (name === 'script.js') {
    const legacyState = "const toast = $('#toast');\nlet toastTimer;\n";
    const legacyAdapter = "function showToast(message) {\n  if (!message || !toast) return;\n  toast.textContent = message;\n  toast.classList.add('show');\n  clearTimeout(toastTimer);\n  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);\n}";
    const sharedAdapter = 'function showToast(message, options) {\n  window.ClassicMartFlash.show(message, options);\n}';
    const source = expected.toString('utf8');
    assert.equal(source.split(legacyState).length, 2, 'Exactly one frozen notification state declaration');
    assert.equal(source.split(legacyAdapter).length, 2, 'Exactly one frozen notification adapter');
    expected = Buffer.from(source.replace(legacyState, '').replace(legacyAdapter, sharedAdapter));
  }
  return expected;
}
