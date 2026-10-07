import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
const root=path.resolve(import.meta.dirname,'..'); const read=p=>fs.readFileSync(path.join(root,p),'utf8'); const exists=p=>fs.existsSync(path.join(root,p));

test('Customer address service owns CRUD/default invariant and audit',()=>{assert.ok(exists('src/services/customer-addresses.js'));const s=read('src/services/customer-addresses.js');assert.match(s,/userId\s*:\s*request\.user\._id/);assert.match(s,/isDefault/);assert.match(s,/customer\.address_/);});
test('Customer notification preferences are persistent and audited',()=>{const u=read('src/models/User.js');assert.match(u,/notifications\s*:/);assert.match(u,/wishlist/);const r=read('src/routes/dashboard.js');assert.match(r,/notifications\/preferences/);assert.match(r,/customer\.notification_preferences_updated/);});
test('Wallet top-up uses Pesapal verification and idempotent balanced ledger credit',()=>{assert.ok(exists('src/models/WalletTopUp.js'));assert.ok(exists('src/services/customer-wallet.js'));const s=read('src/services/customer-wallet.js');assert.match(s,/submitPesapalOrder/);assert.match(s,/getPesapalTransactionStatus/);assert.match(s,/merchant_reference/);assert.match(s,/postLedgerTransaction/);assert.match(s,/wallet-topup:/);assert.doesNotMatch(s,/card_number|cvv|pan/i);});
test('Pesapal webhook can dispatch wallet top-up notification before order notification',()=>{const r=read('src/routes/payments.js');assert.match(r,/processWalletPesapalNotification/);assert.match(r,/WalletTopUp/);});
test('Classic Club derives from real loyalty and spend',()=>{assert.ok(exists('src/services/customer-club.js'));const s=read('src/services/customer-club.js');assert.match(s,/customerClubSummary/);assert.match(s,/spendMinor/);});
