// Reported operation shapes with synthetic URL, credentials, and identifiers.
export const describedRoleRecording = `import { test, expect } from '@playwright/test';
test('test', async ({ page }) => {
  await page.goto('https://example.invalid/login');
  await page.getByRole('textbox', { name: 'Login' }).fill('sample-buyer');
  await page.getByRole('textbox', { name: 'Password' }).fill('sample-password');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('collapse-menu-toggle-button').click();
  await page.getByRole('button', { name: 'travel_explore Sourcing chevron_right' }).click();
  await page.getByTestId('project-list-1234').click();
  await page.frameLocator().locator('iframe[name="tabs-example"]').contentFrame().getByRole('link', { description: 'Search', exact: true }).click();
  await page.frameLocator().getByRole('link', { name: 'New' }).click();
  await page.frameLocator().locator('input[name="toolBarCheck_example"]').check();
  await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().getByRole('link', { name: 'Apply' }).click();
  await expect(page.frameLocator().getByText('GENERAL PROJECT INFORMATION')).toBeVisible();
});`;
