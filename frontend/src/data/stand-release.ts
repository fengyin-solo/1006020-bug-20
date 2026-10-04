import type { EntryRow } from './types'

// 停机位释放相关的固定取值：模块 key、动作名、状态、以及一趟占用由哪几个字段组成。
export const STAND_MODULE_KEY = 'stand'
export const STAND_RELEASE_ACTION = '释放机位'
export const FLIGHT_MODULE_KEY = 'flight'
export const FLIGHT_COMPLETE_ACTION = '确认完成'

const STATUS_FREE = '空闲'
const STATUS_OCCUPIED = '占用中'
// 维护中、已封闭的机位不许走释放，越级操作直接挡回。
const STATUS_NO_RELEASE = ['维护中', '已封闭']

// 一趟占用由这两个字段组成：释放时必须一起清，只改状态会留下上一趟的脏数据。
const OCCUPANCY_FIELDS = ['占用时段', '当前航班'] as const

export type StandReleaseOutcome =
  | { kind: 'released'; rows: EntryRow[]; stand: EntryRow }
  | { kind: 'already-free'; stand: EntryRow }
  | { kind: 'blocked'; stand: EntryRow }
  | { kind: 'foreign-occupation'; stand: EntryRow }
  | { kind: 'not-found' }

/**
 * 停机位释放的唯一一段判断：机位列表的「释放机位」、航班保障的「确认完成」都走这里，
 * 入口不许再各自写一遍。
 * - 维护中 / 已封闭：越级，挡回；
 * - 已经空闲：幂等，同一机位只清一次，不再清第二次；
 * - 占用中、但当前占用登记的是别的航班（flightNo 对不上）：是别人的新占用，不许清；
 * - 其余占用中：置空闲，占用时段、当前航班一起清空。
 */
export function releaseStand(
  rows: EntryRow[],
  standId: number,
  opts: { flightNo?: string } = {},
): StandReleaseOutcome {
  const index = rows.findIndex((row) => Number(row.id) === standId)
  if (index < 0) {
    return { kind: 'not-found' }
  }
  const stand = rows[index]
  const status = String(stand.status)
  if (STATUS_NO_RELEASE.includes(status)) {
    return { kind: 'blocked', stand }
  }
  if (status === STATUS_FREE) {
    return { kind: 'already-free', stand }
  }
  if (status !== STATUS_OCCUPIED) {
    return { kind: 'blocked', stand }
  }
  const occupant = String(stand['当前航班'] ?? '').trim()
  const flightNo = String(opts.flightNo ?? '').trim()
  if (flightNo && occupant && occupant !== flightNo) {
    return { kind: 'foreign-occupation', stand }
  }
  // 标志位与通用流转同一口径：目标态不是末态仍算待处理，释放不是负向动作。
  const released: EntryRow = { ...stand, status: STATUS_FREE, pending: true, abnormal: false }
  for (const field of OCCUPANCY_FIELDS) {
    released[field] = ''
  }
  const next = [...rows]
  next[index] = released
  return { kind: 'released', rows: next, stand: released }
}

/**
 * 老记录清理：早期从航班侧释放的机位只改了状态、占用时段还留着上一趟的，
 * 读库时统一补上这一次清理——空闲机位不允许再挂着占用信息。
 */
export function normalizeStandRows(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const next = rows.map((row) => {
    if (String(row.status) !== STATUS_FREE) {
      return row
    }
    const dirty = OCCUPANCY_FIELDS.some((field) => String(row[field] ?? '').trim() !== '')
    if (!dirty) {
      return row
    }
    changed = true
    const cleaned = { ...row }
    for (const field of OCCUPANCY_FIELDS) {
      cleaned[field] = ''
    }
    return cleaned
  })
  return changed ? { rows: next, changed: true } : { rows, changed: false }
}
