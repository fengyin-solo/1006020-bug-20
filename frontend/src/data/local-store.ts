import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
const CURRENT_VERSION = 2

// v2：机位释放统一走 src/domain/stand.ts，空闲机位不再允许残留占用时段。
// 一份数据分三块：业务模块记录、已释放占用的留痕、结构版本号。
export type PersistedStore = {
  version: number
  modules: Record<string, EntryRow[]>
  releaseLog: string[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshStore(): PersistedStore {
  return { version: CURRENT_VERSION, modules: clone(SEED_ROWS), releaseLog: [] }
}

// v1 -> v2：历史上「航班保障确认完成」那个入口释放机位时漏清了占用时段，
// 会留下「状态已空闲、占用时段还挂着上一趟」的矛盾记录；廊桥侧的待靠接待办
// 也会因此一直读到旧机位。存量数据只在版本升级时修这一遍。
function migrateV1ToV2(modules: Record<string, EntryRow[]>): void {
  const stands = modules.stand ?? []
  for (const stand of stands) {
    if (String(stand.status) !== '空闲') {
      continue
    }
    if (String(stand['占用时段'] ?? '').trim() !== '') {
      stand['占用时段'] = ''
    }
    if (String(stand['当前航班'] ?? '').trim() !== '') {
      stand['当前航班'] = ''
    }
  }
  const bridges = modules.bridge ?? []
  for (const bridge of bridges) {
    if (String(bridge.status) !== '待靠接') {
      continue
    }
    const code = String(bridge['对应机位'] ?? '').trim()
    const stand = stands.find((item) => String(item['机位编号'] ?? '') === code)
    // 机位已经空闲，挂在它上面的待靠接就是不会再发生的旧待办，一并关闭。
    if (stand && String(stand.status) === '空闲') {
      bridge.status = '异常中止'
      bridge.pending = false
      bridge.abnormal = true
      bridge['中止说明'] = '该机位在历史数据中已释放，待靠接待办自动关闭'
    }
  }
}

function normalize(raw: unknown): PersistedStore {
  // v1 的存档直接就是 Record<模块key, 行数组>，v2 包了一层版本结构。
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'modules' in raw) {
    const parsed = raw as Partial<PersistedStore>
    const store: PersistedStore = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      modules: { ...clone(SEED_ROWS), ...(parsed.modules ?? {}) },
      releaseLog: Array.isArray(parsed.releaseLog) ? parsed.releaseLog.map(String) : [],
    }
    if (store.version < CURRENT_VERSION) {
      migrateV1ToV2(store.modules)
      store.version = CURRENT_VERSION
    }
    return store
  }
  const store = freshStore()
  store.modules = { ...store.modules, ...(raw as Record<string, EntryRow[]>) }
  migrateV1ToV2(store.modules)
  return store
}

function readStorage(): PersistedStore {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshStore()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = freshStore()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const store = normalize(JSON.parse(raw))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    return store
  } catch {
    const fallback = freshStore()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: PersistedStore | null = null

function store(): PersistedStore {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store()))
  }
}

export function allRows(): Record<string, EntryRow[]> {
  return store().modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  store().modules[key] = rows
  persist()
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  store().modules[key] = rows
  // 重置会恢复示例占用，旧的释放留痕不能再挡示例数据的释放。
  store().releaseLog = []
  persist()
  return rows
}

// 某次占用的释放留痕：同一趟占用只记一次，重复点击靠它认出来，不会波及新占用。
export function occupancyReleased(marker: string): boolean {
  return store().releaseLog.includes(marker)
}

export function markOccupancyReleased(marker: string): void {
  const log = store().releaseLog
  if (!log.includes(marker)) {
    log.push(marker)
    persist()
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
