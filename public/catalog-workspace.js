(() => {
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  for (const form of document.querySelectorAll('.js-async-upload')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const output = form.querySelector('.upload-result');
      const button = form.querySelector('button[type="submit"]');
      if (!token || !output || !button) return;
      button.disabled = true;
      output.textContent = 'Validating and sanitizing upload…';
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { 'x-csrf-token': token, accept: 'application/json' },
          body: new FormData(form),
          credentials: 'same-origin',
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error?.message || 'Upload failed.');
        }
        output.textContent = 'Upload secured. Refreshing…';
        window.location.reload();
      } catch (error) {
        output.textContent = error.message;
        button.disabled = false;
      }
    });
  }
})();
