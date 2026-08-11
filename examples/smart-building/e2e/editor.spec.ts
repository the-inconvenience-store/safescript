import { expect, test } from '@playwright/test';

test('offers a compact flow with discoverable add and remove controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Building Studio' })).toBeVisible();
  await expect(page.getByLabel('Semantic program graph')).toBeVisible();
  await expect(page.locator('.semantic-node')).toHaveCount(9);
  await expect(page.getByRole('button', { name: 'Add step' })).toBeVisible();
  const source = page.getByLabel('Canonical SafeScript TypeScript source');
  await expect(source).toContainText('temperatureDelta > 25n');
  await page.getByRole('button', { name: 'Edit HVAC rule' }).click();
  await expect(page.getByLabel('Condition expression')).toHaveValue('event.occupied && temperatureDelta > 25n');
  await expect(page.getByLabel('Literal value')).toHaveValue('25');
  await expect(page.getByLabel('Replacement operator')).toHaveValue('&&');

  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByRole('menuitem', { name: /Humidity alert rule/ }).click();
  await expect(source).toContainText('value: "high humidity"');
  await expect(page.locator('.semantic-node')).toHaveCount(11);
  await expect(page.getByRole('button', { name: 'Add step' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Send alert rule' }).click();
  await expect(source).not.toContainText('value: "high humidity"');
  await expect(page.locator('.semantic-node')).toHaveCount(9);
});

test('edits checked SafeScript in both directions and runs it through the SDK', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Building Studio' })).toBeVisible();
  const source = page.getByLabel('Canonical SafeScript TypeScript source');
  await expect(source).toContainText('temperatureDelta > 25n');

  await source.fill((await source.inputValue()).replace('cool to 22C', 'cool to 23C'));
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check & accept source' }).click();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(page.locator('.semantic-node').filter({ hasText: 'cool to 23C' }).first()).toBeVisible();

  await page.locator('.semantic-node').filter({ hasText: 'cool to 23C' }).first().click();
  const value = page.getByLabel('Action value expression');
  await value.fill('event.zoneId');
  await page.getByRole('button', { name: 'Set action value' }).click();
  await expect(source).toContainText('value: event.zoneId');
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('.results pre')).toContainText('"status": "accepted"');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.results pre')).toContainText('"status": "completed"');
  await expect(page.locator('.results pre')).toContainText('"actions"');
  await expect(page.locator('.results pre')).toContainText('"trace"');
  await expect(page.locator('.results pre')).toContainText('"usage"');
});

test('keeps automation cards legible in the mobile pannable canvas', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Add step' })).toBeVisible();
  await expect(page.locator('.semantic-node')).toHaveCount(9);
  const card = await page.locator('.react-flow__node').first().boundingBox();
  expect(card?.width ?? 0).toBeGreaterThan(120);
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth).toBe(390);
});
