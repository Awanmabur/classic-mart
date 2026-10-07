import fs from 'node:fs';
import path from 'node:path';

export function approvedDashboardLayerFailures(root) {
  const failures = [];
  const exists = file => fs.existsSync(path.join(root, file));
  const required = [
    'views/approved-dashboard.ejs', 'views/partials/customer-live-pages.ejs', 'src/dashboard/customer-view.js',
    'public/approved-dashboard/customer-live.js', 'public/approved-dashboard/customer-navigation.js', 'src/routes/approved-dashboard.js',
    'src/dashboard/landing.js', 'public/approved-dashboard/session-entry.js',
    'public/approved-dashboard/session-controls.js', 'test/approved-dashboard.test.js',
  ];
  for (const file of required) if (!exists(file)) failures.push(`Missing approved dashboard file: ${file}`);
  const source = path.join(root, 'dashboard-preview/final19');
  const assets = path.join(source, 'assets');
  const names = ['styles.css', 'design-system.css', 'role-workspaces.css', 'script.js', 'enhancements.js'];
  if (fs.existsSync(assets)) names.push(...fs.readdirSync(assets).map(name => 'assets/' + name));
  else failures.push('Approved preview assets are missing.');
  for (const name of names) {
    const original = path.join(source, name);
    const deployed = path.join(root, 'public/approved-dashboard', name);
    if (!fs.existsSync(original) || !fs.existsSync(deployed) || !fs.readFileSync(original).equals(fs.readFileSync(deployed))) failures.push(`Approved dashboard asset changed or missing: ${name}`);
  }
  for (const file of ['public/dashboard.js', 'public/dashboard.css', 'public/dashboard/runtime.js', 'public/dashboard/customer.js', 'public/dashboard-v19/platform-bridge.js', 'views/partials/dashboard-customer.ejs']) {
    if (exists(file)) failures.push(`Legacy dashboard UI must be removed: ${file}`);
  }
  if (exists('src/app.js')) {
    const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
    if (!app.includes('app.use(approvedDashboardRoutes)')) failures.push('Approved dashboard router is not mounted.');
    if (app.indexOf('app.use(approvedDashboardRoutes)') > app.indexOf('app.use(dashboardRoutes)')) failures.push('Approved UI must precede legacy customer actions.');
  }
  return failures;
}
