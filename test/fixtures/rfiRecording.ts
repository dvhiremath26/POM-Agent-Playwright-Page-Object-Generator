// Reported action shapes, with synthetic hostname, credentials, and iframe identifiers.
export const rfiSteps = `English Steps:
Test: SSPSRM_eSourcing_RFI_001 - Verify RFI can be created.
 1. Naviagte to SSP_SRM application
 2. Enter Username
 3. Enter Password
 4. Click on Continue button
 5. Navigate to Project List menu
 6. Click on Search icon
 7. Click on New button
 8. Check the e-Sourcing - RFI checkbox
 9. Click Apply button`;

const main = `page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame()`;
const tabs = `${main}.locator('iframe[name="tabsA"]').contentFrame().locator('iframe[name="tabsB"]').contentFrame()`;
export const rfiRecording = `import { test, expect } from '@playwright/test';
test('test', async ({ page }) => {
 const page1Promise = page.waitForEvent('popup');
 await page.goto('https://example.invalid/nova52/loginprocess');
 const page1 = await page1Promise;
 await page.getByRole('textbox', { name: 'Login' }).fill('sample-buyer');
 await page.getByRole('textbox', { name: 'Password' }).fill('sample-password');
 await page.getByRole('button', { name: 'Continue' }).click();
 await page.getByTestId('sourcing-1234').click();
 await page.getByTestId('project-list-5678').click();
 await ${tabs}.getByRole('link').first().click();
 await ${tabs}.getByRole('link', { name: 'New' }).click();
 await ${main}.getByRole('row', { name: '2 e-Sourcing - RFI' }).getByLabel('').check();
 await ${main}.getByRole('link', { name: 'Apply' }).click();
});`;
