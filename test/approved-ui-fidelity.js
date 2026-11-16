import assert from 'node:assert/strict';

// Retire only the frozen notification blocks requested by the user. Every other
// byte, including colours, layout and whitespace, still belongs to the reference.
export function approvedAssetWithSharedFlash(name, reference) {
  let expected = Buffer.from(reference);
  if (name === 'styles.css' || name === 'design-system.css') {
    const retired = name === 'styles.css'
      ? /\n\.toast \{[^{}]*\n\}\n\n\.toast\.show \{[^{}]*\n\}\n/g
      : /\n\.toast \{[^{}]*\n\}\n/g;
    const source = expected.toString('utf8');
    assert.equal([...source.matchAll(retired)].length, 1, `${name}: exactly one frozen notification block`);
    let cleaned = source.replace(retired, '\n');
    if (name === 'styles.css') {
      // Existing, reviewed accessibility/brand updates to the runtime shell.
      // Only these exact edits may differ from the immutable Final19 preview.
      // Assertions intentionally fail if the original selectors ever change.
      const approvedRuntimeEdits = [
        [
          '  .sidebar-overlay.show {\n    display: block;\n  }',
          '  /* Keep outside-tap dismissal functional without dimming the phone screen. */\n  .sidebar-overlay.show {\n    display: block;\n    background: transparent;\n    box-shadow: none;\n    backdrop-filter: none;\n    -webkit-backdrop-filter: none;\n  }',
        ],
        [
          'color: #16863b; background: #e4f7e9; border-radius: 999px; font-size: 11px; font-weight: 600;',
          'color: var(--blue-dark); background: var(--blue-soft); border-radius: 999px; font-size: 11px; font-weight: 600;',
        ],
        ['.free-text { color: #16863b; }', '.free-text { color: var(--blue); }'],
        [
          '.secure-checkout { margin-top: 13px; justify-content: center; color: var(--muted); font-size: 11px; }\n.wallet-use',
          '.secure-checkout { margin-top: 13px; justify-content: center; color: var(--muted); font-size: 11px; }\n.cart-layout .secure-checkout svg { color: var(--blue); }\n.wallet-use',
        ],
      ];
      for (const [original, approved] of approvedRuntimeEdits) {
        assert.equal(cleaned.split(original).length, 2, 'Exactly one original approved design segment');
        cleaned = cleaned.replace(original, approved);
      }
    }
    expected = Buffer.from(cleaned);
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
