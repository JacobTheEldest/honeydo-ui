import { expect, test } from '@playwright/test'
import { getUserDisplayName } from '../../src/utils/userDisplay.ts'
import type { VikunjaUser } from '../../src/types/vikunja.ts'

test('user labels fall back to the username when Vikunja returns an empty display name', () => {
  const user: VikunjaUser = { id: 1, username: 'jacob', name: '' }
  expect(getUserDisplayName(user)).toBe('jacob')
})
test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/v2/test-reset')
  expect(response.status()).toBe(204)
})

test('user dropdown switches the task list to the selected assignee', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()

  const userButton = page.getByRole('button', { name: 'Assigned to jacob' })
  await userButton.click()
  await expect(userButton).toHaveAttribute('aria-expanded', 'true')
  const listbox = page.getByRole('listbox', { name: 'Assigned user' })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: 'Laya' }).click()

  await expect(page.getByRole('button', { name: 'Assigned to Laya' })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('[data-task-id="40"]')).toBeVisible()
  await expect(page.locator('[data-task-id="1"]')).toHaveCount(0)
})
