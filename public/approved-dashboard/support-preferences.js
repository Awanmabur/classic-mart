(() => {
  'use strict';
  const body = document.body;
  if (body?.dataset.dashboardWorkspace !== 'support') return;
  const minutes = Number(body.dataset.supportIdleMinutes);
  if (![15, 30, 60].includes(minutes)) return;

  const idleDuration = minutes * 60_000;
  let lastActivity = Date.now();
  let timer;
  let notice;

  function removeNotice() {
    notice?.remove();
    notice = undefined;
  }

  function remind() {
    const remaining = idleDuration - (Date.now() - lastActivity);
    if (remaining > 0) {
      timer = window.setTimeout(remind, remaining);
      return;
    }
    if (notice) return;
    notice = document.createElement('aside');
    notice.className = 'panel support-idle-reminder';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.setAttribute('aria-atomic', 'true');
    const message = document.createElement('p');
    message.textContent = `You have been inactive for ${minutes} minutes. Review your signed-in sessions if you have finished working.`;
    const actions = document.createElement('div');
    const review = document.createElement('a');
    review.className = 'plain-link';
    review.href = '/account/security';
    review.textContent = 'Review sessions';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'outline-button';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => recordActivity());
    actions.append(review, dismiss);
    notice.append(message, actions);
    body.append(notice);
  }

  function recordActivity(event) {
    const interactingWithNotice = notice && event?.target instanceof Node && notice.contains(event.target);
    lastActivity = Date.now();
    window.clearTimeout(timer);
    if (!interactingWithNotice) removeNotice();
    timer = window.setTimeout(remind, idleDuration);
  }

  for (const type of ['pointerdown', 'keydown', 'scroll', 'focus']) {
    document.addEventListener(type, recordActivity, { capture: true, passive: true });
  }
  window.addEventListener('focus', recordActivity, { passive: true });
  window.addEventListener('pagehide', () => {
    window.clearTimeout(timer);
    removeNotice();
  });
  window.addEventListener('pageshow', recordActivity, { passive: true });
  timer = window.setTimeout(remind, idleDuration);
})();
