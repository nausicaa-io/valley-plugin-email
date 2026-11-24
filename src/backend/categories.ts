export const MAX_GROUPS_PER_MESSAGE = 3

/** Normalizes persisted or user-selected group IDs into a deduplicated ordered array, falling back to single `categoryId`. */
export function normalizeCategoryIds(categoryIds: unknown, fallbackCategoryId?: unknown, max = MAX_GROUPS_PER_MESSAGE): string[] {
  const result: string[] = []
  const add = (value: unknown) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (!trimmed || trimmed === 'uncategorized' || result.includes(trimmed) || result.length >= max) return
    result.push(trimmed)
  }
  if (Array.isArray(categoryIds)) {
    for (const item of categoryIds) add(item)
  }
  if (!result.length) add(fallbackCategoryId)
  return result
}

/** Encodes group IDs into a pipe-delimited exact-token lookup string for dataset `contains` queries (e.g. `|a|b|`). */
export function encodeCategoryKeys(ids: readonly string[]): string | null {
  const clean = normalizeCategoryIds(ids)
  return clean.length ? `|${clean.join('|')}|` : null
}

/** Projects an assignment row (or raw group IDs) onto the `messages` dataset columns. */
export function messageCategoryProjection(row: { categoryId?: unknown; categoryIds?: unknown } | null | undefined): {
  categoryId: string | null
  categoryIds: string[] | null
  categoryKeys: string | null
} {
  const ids = normalizeCategoryIds(row?.categoryIds, row?.categoryId)
  return {
    categoryId: ids[0] ?? null,
    categoryIds: ids.length ? ids : null,
    categoryKeys: encodeCategoryKeys(ids)
  }
}

export function sameCategoryIds(a: unknown, b: unknown): boolean {
  const left = normalizeCategoryIds(a)
  const right = normalizeCategoryIds(b)
  return left.length === right.length && left.every((id, index) => id === right[index])
}
