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

test('user search finds and selects a user with no assigned tasks', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-task-id="1"]')).toBeVisible()

  const userButton = page.getByRole('button', { name: 'Assigned to jacob' })
  await userButton.click()
  const listbox = page.getByRole('listbox', { name: 'Assigned user' })
  await expect(listbox).toBeVisible()
  const searchResponse = page.waitForResponse((response) =>
    response.url().includes('/api/v2/users?q=unassigned') && response.ok()
  )
  await listbox.getByRole('searchbox', { name: 'Search users' }).fill('unassigned')
  await searchResponse
  await listbox.getByRole('option', { name: 'Unassigned User' }).click()

  await expect(page.getByRole('button', { name: 'Assigned to Unassigned User' })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('No tasks yet')).toBeVisible()
  await expect(page.locator('[data-task-id="1"]')).toHaveCount(0)
})
