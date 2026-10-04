import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  FLIGHT_COMPLETE_ACTION,
  FLIGHT_MODULE_KEY,
  releaseStand,
  STAND_MODULE_KEY,
  STAND_RELEASE_ACTION,
} from '@/data/stand-release'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 入口一：机位列表点「释放机位」。释放判断只有一份，见 data/stand-release.ts。
  if (key === STAND_MODULE_KEY && action === STAND_RELEASE_ACTION) {
    return runStandRelease(meta, id)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  let suffix = ''
  // 入口二：航班保障点「确认完成」，顺带释放该航班占用的机位，走的还是同一段释放判断。
  if (key === FLIGHT_MODULE_KEY && action === FLIGHT_COMPLETE_ACTION) {
    suffix = releaseStandForFlight(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
}

// 机位列表入口：释放结果就是动作结果，成功失败都直接返回给页面。
function runStandRelease(meta: ModuleMeta, id: number): ActionResult {
  const outcome = releaseStand(listRows(STAND_MODULE_KEY), id)
  switch (outcome.kind) {
    case 'released':
      saveRows(STAND_MODULE_KEY, outcome.rows)
      return { ok: true, message: `${meta.entity}已${STAND_RELEASE_ACTION}，当前状态「空闲」` }
    case 'already-free':
      return { ok: false, message: `${meta.entity}已经是「空闲」，不用重复操作` }
    case 'blocked':
      return { ok: false, message: `${meta.entity}处于「${String(outcome.stand.status)}」，不能走释放` }
    case 'foreign-occupation':
      return { ok: false, message: `${meta.entity}当前占用不属于本次操作，未释放` }
    default:
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
}

// 航班保障入口的顺带释放：按机位号找到停机位，走同一段释放判断。
// 找不到机位、机位已空闲、机位被别的新占用占着，都不影响航班任务本身完成。
function releaseStandForFlight(flight: EntryRow): string {
  const standCode = String(flight['机位号'] ?? '').trim()
  if (!standCode) {
    return ''
  }
  const stands = listRows(STAND_MODULE_KEY)
  const stand = stands.find((row) => String(row['机位编号'] ?? '').trim() === standCode)
  if (!stand) {
    return ''
  }
  const outcome = releaseStand(stands, Number(stand.id), {
    flightNo: String(flight['航班号'] ?? ''),
  })
  switch (outcome.kind) {
    case 'released':
      // 写回同一份机位数据，廊桥靠接等其它模块读到的就是释放后的结果，不会是旧的。
      saveRows(STAND_MODULE_KEY, outcome.rows)
      return `；占用机位 ${standCode} 已一并释放`
    case 'blocked':
      return `；机位 ${standCode} 处于「${String(outcome.stand.status)}」，未执行释放`
    case 'foreign-occupation':
      return `；机位 ${standCode} 已有新的占用，未重复释放`
    default:
      return ''
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
