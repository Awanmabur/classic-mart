
(() => {
  'use strict';

  const drawer = document.getElementById('classicAiDrawer');
  const openButton = document.getElementById('classicAiBtn');
  const form = document.getElementById('classicAiForm');
  const input = document.getElementById('classicAiInput');
  const thread = document.getElementById('classicAiThread');
  const context = document.getElementById('classicAiContext');
  const suggestionHost = document.getElementById('classicAiSuggestions');
  if (!drawer || !openButton || !form || !input || !thread || !suggestionHost) return;

  const roleNames = {
    customer: 'Customer',
    seller: 'Seller',
    promoter: 'Promoter',
    admin: 'Admin',
    superadmin: 'Super Admin',
    finance: 'Finance',
    support: 'Support',
    warehouse: 'Warehouse',
    moderator: 'Moderation',
    business: 'Business Buyer'
  };

  const roleSuggestions = {
    customer: ['Summarize my account', 'What needs my attention?', 'Help with an order'],
    seller: ['What should I do first?', 'Summarize store performance', 'Find inventory risks'],
    promoter: ['Which campaign looks strongest?', 'Summarize conversions', 'What needs attention?'],
    admin: ['Summarize operations', 'Show priority approvals', 'Where are the bottlenecks?'],
    superadmin: ['Executive summary', 'Show platform risks', 'What needs approval?'],
    finance: ['Summarize reconciliation', 'Show money movement risks', 'What needs review?'],
    support: ['Summarize the queue', 'Which cases are urgent?', 'How is SLA performance?'],
    warehouse: ['Summarize fulfilment', 'Show stock risks', 'What ships next?'],
    moderator: ['Summarize trust queues', 'Show high-risk cases', 'What needs evidence?'],
    business: ['Summarize company spend', 'Show delayed orders', 'What needs approval?']
  };

  const roleAnswers = {
    customer: 'Your account is in good shape. The most useful next steps are to review the shipment arriving soon, confirm your return pickup, and use available reward points only when the redemption gives you better value.',
    seller: 'Store health is strong. Prioritize low-stock items first, then orders waiting for handover, then unanswered customer messages. Those actions protect availability, fulfilment SLA, and conversion.',
    promoter: 'Campaign performance is healthy. Technology campaigns have the strongest conversion quality, while WhatsApp is producing the best attributed traffic. Review pending conversions before creating more links.',
    admin: 'Operations are stable, but approvals and order exceptions are the highest-value queues. Clear ready seller applications first, then resolve fulfilment exceptions, then finish scheduled campaign content.',
    superadmin: 'Platform health is strong. The highest-priority executive items are high-risk disputes, privileged-access review, and settlement confirmation. No critical infrastructure issue is represented in this standalone sample.',
    finance: 'Reconciliation is healthy at 99.7%. Resolve provider mismatches before initiating any retry, review urgent refunds next, then confirm the payout batch against provider truth and internal ledger state.',
    support: 'Service health is on target. Escalated cases should be handled first, followed by customers waiting on replies. Keep transfers reasoned and visible so queue ownership does not hide SLA risk.',
    warehouse: 'Fulfilment is healthy. Dispatch packed orders first, investigate stock variances before new picking, then receive inbound stock with quantity and condition evidence to protect inventory accuracy.',
    moderator: 'Trust queues are improving. Review high-risk listings first, then manipulation signals and seller appeals. Preserve evidence and decision reasons so appeals can be handled without losing the audit trail.',
    business: 'Company buying is within control. Approve pending purchases, follow up delayed deliveries, then review supplier concentration and monthly spend before repeating high-value orders.'
  };

  let lastFocused = null;

  function currentRole() {
    return window.ClassicRoleDashboard?.getCurrentRole?.() || document.body.dataset.workspace || 'customer';
  }

  function currentPageTitle() {
    return document.querySelector('.app-page.active h1')?.textContent?.trim() || 'Dashboard';
  }

  function updateContext() {
    const role = currentRole();
    context.textContent = `${roleNames[role] || 'Classic Mart'} · ${currentPageTitle()}`;
    suggestionHost.innerHTML = '';
    (roleSuggestions[role] || roleSuggestions.customer).forEach(text => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.addEventListener('click', () => {
        input.value = text;
        input.focus();
      });
      suggestionHost.appendChild(button);
    });
  }

  function openDrawer() {
    lastFocused = document.activeElement;
    updateContext();
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => input.focus());
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    lastFocused?.focus?.();
  }

  function appendMessage(kind, text) {
    const article = document.createElement('article');
    article.className = `ai-message ${kind}`;
    if (kind === 'assistant') {
      article.innerHTML = '<span class="ai-avatar"><svg><use href="#i-sparkles"></use></svg></span>';
    }
    const body = document.createElement('div');
    if (kind === 'assistant') {
      const strong = document.createElement('strong');
      strong.textContent = 'Classic AI';
      body.appendChild(strong);
    }
    const p = document.createElement('p');
    p.textContent = text;
    body.appendChild(p);
    article.appendChild(body);
    thread.appendChild(article);
    thread.scrollTop = thread.scrollHeight;
  }

  function answerFor(message) {
    const role = currentRole();
    const lower = message.toLowerCase();
    const page = currentPageTitle();

    if (/security|risk|fraud|safe/.test(lower)) {
      return `For ${page}, start with the items marked critical or requiring evidence. Do not bypass approvals, money controls, role scope, or audit history. In this standalone demo I can explain the workflow, but I do not execute privileged actions.`;
    }
    if (/export|report|download/.test(lower)) {
      return `Use the report/export action in ${page} after confirming the active filters and role scope. Production exports should remain permission-scoped, audited, privacy-aware, and protected against spreadsheet-formula injection.`;
    }
    if (/what|first|priority|attention|urgent|summary|summarize|performance|strongest|bottleneck|risk|ships|stock|approval|spend|queue|reconciliation/.test(lower)) {
      return roleAnswers[role] || roleAnswers.customer;
    }
    return `${roleNames[role] || 'This'} workspace is currently on ${page}. I can summarize the page, identify the priority queue, explain a metric, or suggest the next controlled action using the information visible in this standalone dashboard.`;
  }

  openButton.addEventListener('click', openDrawer);
  drawer.querySelectorAll('[data-ai-close]').forEach(el => el.addEventListener('click', closeDrawer));

  form.addEventListener('submit', event => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    appendMessage('user', message);
    input.value = '';
    window.setTimeout(() => appendMessage('assistant', answerFor(message)), 180);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drawer.classList.contains('open')) {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      const search = document.getElementById('searchInput');
      search?.focus();
      search?.select?.();
    }
    if (event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      drawer.classList.contains('open') ? closeDrawer() : openDrawer();
    }
  });

  document.addEventListener('click', event => {
    if (event.target.closest('[data-page-target]')) window.setTimeout(updateContext, 0);
  });
  window.addEventListener('popstate', () => window.setTimeout(updateContext, 0));
  document.getElementById('roleSwitcher')?.addEventListener('change', () => window.setTimeout(updateContext, 0));

  updateContext();
})();
