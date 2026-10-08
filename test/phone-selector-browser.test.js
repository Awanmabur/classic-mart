import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { getPhoneCountries } from '../src/services/phone-countries.js';

const base = process.env.CLASSIC_MART_LIVE_BASE_URL;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const expectedOptions = getPhoneCountries().map(country => ({
  value: country.code,
  label: `${country.name} (${country.phonePrefix})`,
  prefix: country.phonePrefix,
}));

test('signup phone selector shows only the calling code while keeping alphabetic native country options, keyboard access and reset on desktop and mobile', { skip: !base || !executablePath }, async () => {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [1366, 390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      assert.equal((await page.goto(base + '/signup')).status(), 200);
      const selector = page.getByRole('combobox', { name: 'Phone country code', exact: true });
      const control = page.locator('.phone-country-control');
      const display = control.locator('.phone-country-display');
      await expect(control).toHaveClass(/phone-country-enhanced/);
      assert.equal(await selector.evaluate(element => element.tagName), 'SELECT');
      assert.equal(await display.getAttribute('aria-hidden'), 'true');
      assert.deepEqual(await selector.locator('option').evaluateAll(options => options.map(option => ({
        value: option.value,
        label: option.textContent.trim(),
        prefix: option.dataset.phonePrefix,
      }))), expectedOptions);
      const initialPrefix = await selector.locator('option:checked').getAttribute('data-phone-prefix');
      await expect(display).toHaveText(initialPrefix);

      await selector.selectOption('US');
      await expect(display).toHaveText('+1');
      await expect(selector.locator('option:checked')).toHaveText('United States (+1)');
      await selector.selectOption('UG');
      await expect(display).toHaveText('+256');
      await expect(selector.locator('option:checked')).toHaveText('Uganda (+256)');

      const treatment = await control.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const visibleDisplay = element.querySelector('.phone-country-display');
        const style = getComputedStyle(visibleDisplay);
        const select = element.querySelector('select');
        const selectStyle = getComputedStyle(select);
        return {
          width: rect.width,
          height: rect.height,
          inset: visibleDisplay.getBoundingClientRect().left - rect.left,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          selectColor: selectStyle.color,
          optionColor: getComputedStyle(select.options[select.selectedIndex]).color,
          pillRadius: getComputedStyle(element.closest('.auth-phone-wrap')).borderRadius,
        };
      });
      assert.equal(treatment.width, 108);
      assert.ok(treatment.height >= 48, 'country selector retains a comfortable click target');
      assert.ok(Math.abs(treatment.inset - 20) <= 1, 'calling code uses the reference left inset');
      assert.equal(treatment.fontSize, '13px');
      assert.equal(treatment.fontWeight, '400');
      assert.equal(treatment.pillRadius, '28px');
      assert.equal(treatment.selectColor, 'rgba(0, 0, 0, 0)');
      assert.notEqual(treatment.optionColor, 'rgba(0, 0, 0, 0)');
      assert.ok((await page.locator('[name="phone"]').boundingBox()).width >= 80);

      await selector.selectOption(expectedOptions[0].value);
      await selector.focus();
      await selector.press('ArrowDown');
      await expect(selector).toHaveValue(expectedOptions[1].value);
      await expect(display).toHaveText(expectedOptions[1].prefix);
      await expect(selector).toBeFocused();
      await selector.selectOption(initialPrefix === '+1' ? 'UG' : 'US');
      await selector.evaluate(element => element.form.reset());
      await expect(display).toHaveText(initialPrefix);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('signup phone selector remains a readable native country control when JavaScript is disabled', { skip: !base || !executablePath }, async () => {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 950 } });
    const page = await context.newPage();
    assert.equal((await page.goto(base + '/signup')).status(), 200);
    const selector = page.getByRole('combobox', { name: 'Phone country code', exact: true });
    const control = page.locator('.phone-country-control');
    await expect(control).not.toHaveClass(/phone-country-enhanced/);
    assert.notEqual(await selector.evaluate(element => getComputedStyle(element).color), 'rgba(0, 0, 0, 0)');
    await expect(control.locator('.phone-country-display')).toBeHidden();
    await selector.selectOption('UG');
    await expect(selector.locator('option:checked')).toHaveText('Uganda (+256)');
    await selector.focus();
    await expect(selector).toBeFocused();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await browser.close();
  }
});
