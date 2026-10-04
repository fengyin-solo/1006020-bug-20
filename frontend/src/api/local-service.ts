import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { releaseStand } from '@/domain/stand'
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

// 通用状态流转：不涉及跨模块联动的普通动作都走这里。
function applyStatusTransition(meta: ModuleMeta, id: number, action: string): ActionResult {
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(meta.key)
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
  saveRows(meta.key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 机位列表入口的「释放机位」：跨模块的判断全部委托给统一的机位释放逻辑。
export function releaseStandFromList(id: number): ActionResult {
  const meta = moduleMeta('stand')
  const row = listRows(meta.key).find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  return releaseStand(String(row['机位编号'] ?? ''), { source: 'stand-list' })
}

// 航班保障入口的「确认完成」：先完成本模块状态流转，再顺带释放机位，
// 释放这一步和机位列表走的是同一个函数，行为不会再有差异。
export function completeFlightAndReleaseStand(id: number): ActionResult {
  const meta = moduleMeta('flight')
  const rows = listRows(meta.key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const flight = rows[index]
  const flightLabel = `航班 ${String(flight['航班号'] ?? id)}`

  const transition = applyStatusTransition(meta, id, '确认完成')
  if (!transition.ok) {
    // 已经是终态时不允许改写数据，但仍要补走一遍释放判断：
    // 这正是历史上从航班侧漏清占用时段的那条路径。
    const release = releaseStand(String(flight['机位号'] ?? ''), {
      source: 'flight',
      expectedFlight: String(flight['航班号'] ?? ''),
      flightLabel,
    })
    if (release.ok) {
      return { ok: true, message: `${transition.message}；${release.message}` }
    }
    // 真正的挡回（维护中/已封闭/占用航班对不上）才作为失败透出。
    return release
  }

  const release = releaseStand(String(flight['机位号'] ?? ''), {
    source: 'flight',
    expectedFlight: String(flight['航班号'] ?? ''),
    flightLabel,
  })
  // 航班完成照常生效；但机位释放被挡回（维护中/已封闭/占用航班对不上）时，
  // 用 ok:false 把原因透传给值班人员，由机位侧处理，不能假装什么都没发生。
  return {
    ok: release.ok,
    message: `${transition.message}；${release.message}`,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === 'stand' && action === '释放机位') {
    return releaseStandFromList(id)
  }
  if (key === 'flight' && action === '确认完成') {
    return completeFlightAndReleaseStand(id)
  }
  const meta = moduleMeta(key)
  return applyStatusTransition(meta, id, action)
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
