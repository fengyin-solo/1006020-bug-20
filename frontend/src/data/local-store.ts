import { SEED_ROWS } from './seed'
import { normalizeStandRows, STAND_MODULE_KEY } from './stand-release'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 老记录迁移：历史数据里「状态已空闲、占用时段还挂着上一趟」的机位，读进来时统一清掉，
// 清过的数据写回存储，之后按占用时段检索不会再把空闲机位算成占用。
function sanitizeStored(
  record: Record<string, EntryRow[]>,
): { record: Record<string, EntryRow[]>; changed: boolean } {
  const stands = record[STAND_MODULE_KEY]
  if (!stands) {
    return { record, changed: false }
  }
  const normalized = normalizeStandRows(stands)
  if (!normalized.changed) {
    return { record, changed: false }
  }
  return { record: { ...record, [STAND_MODULE_KEY]: normalized.rows }, changed: true }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return sanitizeStored(fallback).record
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = sanitizeStored(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded.record))
    return seeded.record
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = sanitizeStored({ ...fallback, ...parsed })
    if (merged.changed) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged.record))
    }
    return merged.record
  } catch {
    const seeded = sanitizeStored(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded.record))
    return seeded.record
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  let rows = clone(SEED_ROWS[key] ?? [])
  if (key === STAND_MODULE_KEY) {
    // 重置也过一遍同一个清理，重置出来的数据和迁移后的口径一致。
    rows = normalizeStandRows(rows).rows
  }
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
