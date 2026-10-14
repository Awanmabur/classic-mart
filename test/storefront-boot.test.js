import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { supportedCountries } from '../src/config/marketplace-reference.js';

const script = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
// Run the actual catalogue initialization and formatter before DOM rendering begins.
const initialization = script.slice(0, script.indexOf('  function marketingMotionAllowed'));
const formatter = script.slice(script.indexOf('  function money('), script.indexOf('  function deliveryTimeLabel'));
const bootstrap = `${initialization}${formatter}\nglobalThis.normalizedProducts = products;\n})();`;

for (const country of supportedCountries) {
  test(`homepage initializes shipping prices before rendering for ${country.code}`, () => {
    const threshold = country.freeStandardShippingThresholdMinor;
    const context = {
      document: {
        getElementById: () => ({ textContent: JSON.stringify({
          country,
          products: [
            { id: 'with-currency', currency: country.currency, freeStandardShippingThreshold: threshold },
            { id: 'country-currency', freeStandardShippingThreshold: threshold },
          ],
        }) }),
      },
      window: { matchMedia: () => ({ matches: false }) },
    };

    vm.runInNewContext(bootstrap, context);

    const expectedPrice = new Intl.NumberFormat(country.locale, { style: 'currency', currency: country.currency }).format(threshold);
    assert.equal(context.normalizedProducts.length, 2);
    for (const product of context.normalizedProducts) {
      assert.ok(product.shippingInformation.includes(expectedPrice), product.shippingInformation);
    }
  });
}
