import { expect, test } from '@playwright/test';

test('edits checked SafeScript in both directions and runs it through the SDK', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Building Studio' })).toBeVisible();
  await expect(page.getByLabel('Semantic program graph')).toBeVisible();
  const source = page.getByLabel('Canonical SafeScript TypeScript source');
  await expect(source).toContainText('temperatureDelta > 25n');

  await source.fill((await source.inputValue()).replace('cool to 22C', 'cool to 23C'));
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check & accept source' }).click();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(page.locator('.semantic-node').filter({ hasText: 'cool to 23C' }).first()).toBeVisible();

  await page.locator('.semantic-node').filter({ hasText: 'cool to 23C' }).first().click();
  const value = page.getByLabel('New value or source fragment');
  await value.fill('cool to 20C');
  await page.getByRole('button', { name: 'Set literal' }).click();
  await expect(source).toContainText('value: "cool to 20C"');
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('.results pre')).toContainText('"status": "accepted"');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.results pre')).toContainText('"status": "completed"');
  await expect(page.locator('.results pre')).toContainText('"actions"');
  await expect(page.locator('.results pre')).toContainText('"trace"');
  await expect(page.locator('.results pre')).toContainText('"usage"');
});
