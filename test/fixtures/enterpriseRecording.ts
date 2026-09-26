// Reproduces the reported operation shapes; all hostnames, credentials and IDs are synthetic.
export const enterpriseRecording = `import { test, expect } from '@playwright/test'
test('test', async ({ page }) => {
 const page1Promise = page.waitForEvent('popup')
 await page.goto('https://example.invalid/nova52/loginprocess')
 const page1 = await page1Promise
 await page.getByRole('textbox', { name: 'Login' }).fill('test-buyer')
 await page.getByRole('textbox', { name: 'Password' }).click()
 await page.getByRole('textbox', { name: 'Login' }).fill('test-buyer-typo')
 await page.getByRole('textbox', { name: 'Password' }).fill('x')
 await page.getByRole('textbox', { name: 'Login' }).click()
 await page.getByRole('textbox', { name: 'Login' }).fill('test-buyer')
 await page.getByRole('textbox', { name: 'Password' }).click()
 await page.getByRole('textbox', { name: 'Password' }).fill('redacted-test-value')
 await page.getByRole('button', { name: 'Continue' }).click()
 await page.getByTestId('sourcing-test').click()
 await page.getByTestId('project-list-test').click()
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().locator('iframe[name="iFrameTabs_exampleA"]').contentFrame().locator('iframe[name="iFrameTabs_exampleB"]').contentFrame().getByRole('link').first().click()
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().locator('iframe[name="iFrameTabs_exampleA"]').contentFrame().locator('iframe[name="iFrameTabs_exampleB"]').contentFrame().getByRole('link', { name: 'New' }).click()
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().getByRole('row', { name: '2 e-Sourcing - RFI' }).getByLabel('').check()
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().getByRole('link', { name: 'Apply' }).click()
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().locator('iframe[name="iFrameTabs_exampleC"]').contentFrame().getByRole('cell', { name: 'New project' }).getByRole('textbox').click()
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().locator('iframe[name="iFrameTabs_exampleC"]').contentFrame().getByText('Test Buyer').click()
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().locator('iframe[name="iFrameTabs_exampleC"]').contentFrame().getByText('-', { exact: true }).click()
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().locator('iframe[name="iFrameTabs_exampleC"]').contentFrame().getByRole('row', { name: 'Comments addressed to supplier' }).getByRole('textbox').click()
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().locator('iframe[name="iFrameTabs_exampleC"]').contentFrame().getByRole('cell', { name: 'Real' }).getByRole('combobox').selectOption('fake-option-one',)
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().locator('iframe[name="iFrameTabs_exampleC"]').contentFrame().getByRole('row', { name: 'Business Type' }).getByRole('combobox').selectOption('fake-option-two',)
 await page.locator('[data-testid="iframe"]').contentFrame().locator('iframe[name="frmMain"]').contentFrame().locator('iframe[name="iFrameTabs_exampleC"]').contentFrame().locator('.selectize-input').first().click()
})`;
