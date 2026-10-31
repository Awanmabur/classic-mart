/* Small, one-time entrances shared by storefronts and live role workspaces.
   Content stays visible until the observer starts an animation; CSS/JS failure
   therefore never strands an invisible card or changes native scrolling. */
(() => {
  'use strict';
  if (window.ClassicMartMotion) return;

  const selector = [
    '[data-scroll-motion]',
    'main .section-heading', 'main .page-heading', 'main .page-header',
    '.panel', '.stat-card', '.summary-card', '.product-card', '.compact-product', '.recommend-card',
    '.mini-product-card', '.catalog-product-card', '.people-card', '.blog-card',
    '.info-card', '.benefit-item', '.profile-hero', '.marketplace-intro',
  ].join(',');
  const excluded = 'nav, header, footer, form, dialog, [role="dialog"], [role="alert"], [role="status"], [aria-live], [hidden], [inert], [data-motion="off"], [data-scroll-motion="off"], .modal, .modal-backdrop, .filter-drawer, .search-suggestions, .promo-card, .hero-slider, .platform-flash-stack';
  const controls = 'a, button, input, select, textarea, label, summary, [role="button"], [role="tab"], [contenteditable="true"]';
  const variants = ['up', 'left', 'right', 'zoom', 'zoom-out', 'down', 'drop'];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection;
  const disabled = () => reduced.matches || connection?.saveData || document.documentElement.dataset.lowData === 'true';
  const seen = new WeakSet();
  const pending = new Set();
  const active = new Map();
  const scans = new Set();
  let observer, mutations, frame = 0, sequence = 0, suspended = false;

  function finish(element) {
    const timer = active.get(element);
    if (timer !== undefined) window.clearTimeout(timer);
    active.delete(element);
    element.classList.remove('platform-motion-enter');
    element.removeAttribute('data-platform-motion');
    for (const property of ['--cm-motion-delay', '--cm-motion-rest', '--cm-motion-opacity']) element.style.removeProperty(property);
  }

  function reveal(element) {
    observer?.unobserve(element);
    pending.delete(element);
    // Keyboard and pointer actions always win over decoration.
    if (!element.isConnected || document.hidden || suspended || disabled() ||
        element.closest(excluded) || element.contains(document.activeElement) || element.matches(':hover')) return;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible' || style.animationName !== 'none') return;
    const requested = element.getAttribute('data-scroll-motion');
    let index = 0;
    for (let sibling = element.previousElementSibling; sibling && index < 3; sibling = sibling.previousElementSibling) {
      if (sibling.matches(selector)) index++;
    }
    element.style.setProperty('--cm-motion-delay', `${Math.min(index, 3) * 55}ms`);
    element.style.setProperty('--cm-motion-rest', style.transform === 'none' ? 'translate3d(0, 0, 0)' : style.transform);
    element.style.setProperty('--cm-motion-opacity', style.opacity);
    element.setAttribute('data-platform-motion', variants.includes(requested) ? requested : variants[sequence++ % variants.length]);
    element.classList.add('platform-motion-enter');
    // Also settle if CSS is unavailable or animationend never arrives.
    active.set(element, window.setTimeout(() => finish(element), 1_000));
  }

  function scan(root) {
    if (!observer || disabled() || suspended || !root?.isConnected) return;
    const candidates = [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
    for (const element of candidates) {
      if (seen.has(element) || element.matches(controls) || element.closest(excluded)) continue;
      // Animate a card once, rather than moving its heading/child card again.
      if (element.parentElement?.closest(selector)) continue;
      seen.add(element);
      pending.add(element);
      observer.observe(element);
    }
  }

  function queueScan(root) {
    if (!root?.querySelectorAll) return;
    scans.add(root);
    if (!frame && !document.hidden && !suspended) frame = requestAnimationFrame(() => {
      frame = 0;
      const roots = [...scans]; scans.clear();
      for (const candidate of roots) if (!roots.some(other => other !== candidate && other.contains(candidate))) scan(candidate);
      // Removed content must not be retained by a long-lived dashboard observer.
      for (const element of pending) if (!element.isConnected) { observer?.unobserve(element); pending.delete(element); }
      for (const element of active.keys()) if (!element.isConnected) finish(element);
    });
  }

  function settleAll() {
    for (const element of active.keys()) finish(element);
    observer?.disconnect();
    for (const element of pending) seen.delete(element);
    pending.clear();
    cancelAnimationFrame(frame); frame = 0; scans.clear();
  }

  function refresh() {
    if (document.hidden || disabled() || suspended) {
      settleAll();
      document.documentElement.classList.remove('platform-motion-ready');
      return;
    }
    document.documentElement.classList.add('platform-motion-ready');
    // Pending cards remain eligible after a hidden tab or reduced-motion change.
    scan(document.body);
  }

  function start() {
    if (typeof IntersectionObserver !== 'function') return;
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) reveal(entry.target);
    }, { threshold: .06, rootMargin: '0px 0px -18px 0px' });
    mutations = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.attributeName !== 'class' || record.target.matches('.app-page, .page-host')) queueScan(record.target);
          continue;
        }
        for (const node of record.addedNodes) if (node.nodeType === 1) queueScan(node);
        if (record.removedNodes.length) queueScan(record.target);
      }
    });
    const watchOptions = { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'class'] };
    mutations.observe(document.body, watchOptions);
    document.addEventListener('animationend', event => { if (active.has(event.target) && event.animationName.startsWith('cmEntrance')) finish(event.target); });
    const interrupt = event => {
      for (const element of active.keys()) if (element.contains(event.target)) finish(element);
    };
    document.addEventListener('focusin', interrupt, true);
    document.addEventListener('pointerover', interrupt, { passive: true });
    document.addEventListener('visibilitychange', refresh);
    reduced.addEventListener('change', refresh);
    connection?.addEventListener?.('change', refresh);
    window.addEventListener('pagehide', () => { suspended = true; settleAll(); mutations.disconnect(); });
    window.addEventListener('pageshow', () => { suspended = false; mutations.observe(document.body, watchOptions); refresh(); });
    refresh();
  }

  window.ClassicMartMotion = Object.freeze({ refresh: () => queueScan(document.body) });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
