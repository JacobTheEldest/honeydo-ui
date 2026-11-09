import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dueDateToPosition,
  isLegacyOrderingDate,
  migrateLegacyDueDate,
  positionToDueDate,
} from '../src/utils/ordering.ts'

test('legacy ordering dates are recognized and migrated to the current epoch', () => {
  const legacy = '2000-01-01T00:10:00.000Z'
  assert.equal(isLegacyOrderingDate(legacy), true)
  assert.equal(migrateLegacyDueDate(legacy), '2100-01-01T00:10:00.000Z')
})

test('migration preserves the persisted ordering position', () => {
  const legacyPositions = [-2, -0.5, 0, 0.25, 10, 120]
  for (const position of legacyPositions) {
    const legacyDueDate = new Date(new Date('2000-01-01T00:00:00Z').getTime() + position * 60_000).toISOString()
    const migrated = migrateLegacyDueDate(legacyDueDate)
    assert.equal(dueDateToPosition(migrated), position)
  }
})

test('current-epoch dates are left untouched by migration', () => {
  for (const position of [-1, 0, 0.5, 100]) {
    const dueDate = positionToDueDate(position)
    assert.equal(isLegacyOrderingDate(dueDate), false)
    assert.equal(migrateLegacyDueDate(dueDate), dueDate)
    assert.equal(dueDateToPosition(dueDate), position)
  }
})
