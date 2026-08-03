(() => {
  'use strict';
  const forms = [...document.querySelectorAll('form[data-offline-action]')];
  if (!forms.length || !('indexedDB' in window)) return;
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const statusBox = document.getElementById('offline-status');
  const DB_NAME = 'classic-mart-delivery-actions';
  const STORE = 'actions';
  let flushing = false;

  const randomId = () => `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
  const setStatus = (message) => {
    if (!statusBox) return;
    statusBox.textContent = message;
    statusBox.dataset.visible = message ? 'true' : 'false';
  };
  const openDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'clientActionId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const txRequest = async (mode, work) => {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try { result = work(store); } catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Offline queue transaction aborted.'));
      });
    } finally { db.close(); }
  };
  const put = (record) => txRequest('readwrite', store => store.put(record));
  const remove = (id) => txRequest('readwrite', store => store.delete(id));
  const all = async () => {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  };
  const send = async (record) => {
    const response = await fetch('/api/v1/delivery/actions', {
      method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(record)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body?.error?.message || body?.message || 'Delivery action failed.'); error.status = response.status; throw error; }
    return body;
  };
  const flush = async () => {
    if (flushing || !navigator.onLine) return;
    flushing = true;
    try {
      const queued = await all();
      if (!queued.length) { setStatus(''); return; }
      setStatus(`Syncing ${queued.length} queued delivery action${queued.length === 1 ? '' : 's'}…`);
      let completed = 0;
      for (const record of queued.sort((a,b) => a.queuedAt - b.queuedAt)) {
        try {
          await send(record);
          await remove(record.clientActionId);
          completed += 1;
        } catch (error) {
          // A 4xx/5xx means the server rejected the transition or proof. Keep the
          // record only for temporary network/server errors; invalid transitions
          // must not replay forever.
          if (navigator.onLine && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
            await remove(record.clientActionId);
            setStatus(`A queued delivery action was rejected and removed: ${error.message}`);
          } else {
            setStatus(`Synchronization paused; the queued action was kept for retry: ${error.message}`);
          }
          break;
        }
      }
      if (completed && completed === queued.length) {
        setStatus('Queued delivery actions synchronized. Refreshing…');
        location.reload();
      }
    } finally { flushing = false; }
  };

  forms.forEach(form => form.addEventListener('submit', async event => {
    if (navigator.onLine) return; // normal form submission keeps progressive enhancement.
    event.preventDefault();
    const data = new FormData(form);
    const record = {
      clientActionId: randomId(),
      shipmentId: form.dataset.shipmentId || '',
      action: form.dataset.action || '',
      proofCode: String(data.get('proofCode') || ''),
      reason: String(data.get('reason') || ''),
      rescheduledFor: String(data.get('rescheduledFor') || ''),
      queuedAt: Date.now()
    };
    try {
      await put(record);
      form.reset();
      const queued = await all();
      setStatus(`Offline: ${queued.length} delivery action${queued.length === 1 ? '' : 's'} queued securely on this device.`);
    } catch {
      setStatus('This action could not be queued on this device. Reconnect and try again.');
    }
  }));
  window.addEventListener('online', flush);
  window.addEventListener('offline', () => setStatus('Offline mode: eligible delivery actions will be queued and validated by the server after reconnection.'));
  if (!navigator.onLine) setStatus('Offline mode: eligible delivery actions will be queued and validated by the server after reconnection.');
  else flush();
})();
