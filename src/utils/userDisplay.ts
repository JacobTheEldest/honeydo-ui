import type { VikunjaUser } from '../types/vikunja.ts'

export function getUserDisplayName(user: VikunjaUser): string {
  return user.name?.trim() || user.username
}
