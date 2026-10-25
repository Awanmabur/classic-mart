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
    expected = Buffer.from(source.replace(retired, '\n'));
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
