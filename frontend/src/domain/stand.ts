import {
  listRows,
  markOccupancyReleased,
  occupancyReleased,
  saveRows,
} from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 机位释放的唯一入口。机位列表的「释放机位」和航班保障的「确认完成」
// 都必须走这里，不允许在页面或别的模块各写一遍释放判断——
// 以前两个入口结果不一致（一个清占用时段、一个漏清），根因就在那里。

export type StandReleaseInput = {
  // 发起释放的入口，仅用于组织返回文案。
  source?: 'stand-list' | 'flight'
  // 航班侧释放时带上的航班号：用于确认机位上的占用还是这一趟，
  // 避免用户对着旧记录点第二次时，把之后新分配进来的占用一起清掉。
  expectedFlight?: string
  // 没有登记机位号（或机位号匹配不到任何机位）时的业务文案，航班侧使用。
  flightLabel?: string
}

export type StandReleaseResult = ActionResult & {
  // 释放后联动关闭的待靠接廊桥条数，调用方可以放进结果文案。
  bridgeCancelled: number
  // 没有实际释放（越级挡回 / 重复释放 / 找不到机位）时为 false。
  released: boolean
}

const IDLE = '空闲'
const OCCUPIED = '占用中'
const BLOCKED_STATUSES = ['维护中', '已封闭']

// 一趟占用的身份指纹：机位编号 + 当前航班 + 占用时段。
// 同一趟的第二次点击指纹相同 -> 跳过；机位被新航班占用后指纹变化 -> 绝不动它。
function occupancyMarker(stand: EntryRow): string {
  return [
    String(stand['机位编号'] ?? ''),
    String(stand['当前航班'] ?? ''),
    String(stand['占用时段'] ?? ''),
  ].join('|')
}

function fail(message: string): StandReleaseResult {
  return { ok: false, released: false, bridgeCancelled: 0, message }
}

function skip(message: string): StandReleaseResult {
  return { ok: true, released: false, bridgeCancelled: 0, message }
}

// 关闭挂在该机位上的待靠接待办：机位释放后这些待办不会再发生，
// 廊桥靠接侧再读到的必须是释放后的结果，不能继续看到旧机位。
function cancelPendingBridges(standCode: string): number {
  const bridges = listRows('bridge')
  let cancelled = 0
  for (const bridge of bridges) {
    if (String(bridge.status) !== '待靠接') {
      continue
    }
    if (String(bridge['对应机位'] ?? '').trim() !== standCode) {
      continue
    }
    bridge.status = '异常中止'
    bridge.pending = false
    bridge.abnormal = true
    bridge['中止说明'] = `机位 ${standCode} 已释放，待靠接待办自动关闭`
    cancelled += 1
  }
  if (cancelled > 0) {
    saveRows('bridge', bridges)
  }
  return cancelled
}

export function releaseStand(standCodeRaw: string, input: StandReleaseInput = {}): StandReleaseResult {
  const source = input.source ?? 'stand-list'
  const standCode = standCodeRaw.trim()
  if (standCode === '') {
    if (source === 'flight') {
      return skip(`${input.flightLabel ?? '该航班'}未登记机位号，无需释放机位`)
    }
    return fail('未指定机位编号，无法释放')
  }

  const stands = listRows('stand')
  const index = stands.findIndex((row) => String(row['机位编号'] ?? '') === standCode)
  if (index < 0) {
    if (source === 'flight') {
      return skip(`机位 ${standCode} 在机位列表中不存在，航班流程照常完成`)
    }
    return fail(`没有找到编号为 ${standCode} 的停机位`)
  }
  const stand = stands[index]
  const status = String(stand.status)

  // 越级挡回：维护中、已封闭的机位不允许走释放，状态必须先走解除维护/解封。
  if (BLOCKED_STATUSES.includes(status)) {
    return fail(`机位 ${standCode} 当前为「${status}」，不允许释放，请先恢复到可用状态`)
  }

  const expectedFlight = input.expectedFlight?.trim() ?? ''
  const currentFlight = String(stand['当前航班'] ?? '').trim()

  // 航班侧只能释放自己那一趟：机位上的当前航班对不上，说明机位已经给了别的航班，
  // 这次点击是旧页面/旧记录发起的，直接挡回，不许碰新占用。
  if (
    source === 'flight' &&
    expectedFlight !== '' &&
    currentFlight !== '' &&
    currentFlight !== expectedFlight
  ) {
    return fail(
      `机位 ${standCode} 当前占用航班为「${currentFlight}」，与本航班「${expectedFlight}」不一致，已跳过释放`,
    )
  }

  const marker = occupancyMarker(stand)

  // 已经释放过的同一趟占用：第二次点击只认幂等，绝不清理之后新进来的占用。
  if (occupancyReleased(marker)) {
    return skip(`机位 ${standCode} 的本次占用已释放过，无需重复操作`)
  }

  // 空闲机位：正常的重复点击直接幂等返回；老版本遗留的「空闲但占用时段残留」
  // 记录在这里补清，保证按占用时段检索时不会再把它误算成占用。
  if (status === IDLE) {
    const hasResidue =
      String(stand['占用时段'] ?? '').trim() !== '' || currentFlight !== ''
    if (hasResidue) {
      const next = [...stands]
      next[index] = { ...stand, '占用时段': '', '当前航班': '' }
      saveRows('stand', next)
    }
    markOccupancyReleased(marker)
    return skip(
      hasResidue
        ? `机位 ${standCode} 已空闲，已补清上一趟遗留的占用时段`
        : `机位 ${standCode} 当前已是空闲，无需重复释放`,
    )
  }

  // 占用中：记一下这一趟占用的指纹，再清空占用时段和当前航班，
  // 第二次点击就会落在上面的空闲分支里，不会波及新占用。
  const next = [...stands]
  next[index] = {
    ...stand,
    status: IDLE,
    pending: false,
    '占用时段': '',
    '当前航班': '',
  }
  saveRows('stand', next)
  markOccupancyReleased(marker)

  const bridgeCancelled = cancelPendingBridges(standCode)
  const suffix = bridgeCancelled > 0 ? `，并关闭 ${bridgeCancelled} 条待靠接廊桥待办` : ''
  return {
    ok: true,
    released: true,
    bridgeCancelled,
    message: `机位 ${standCode} 已释放，占用时段与当前航班已清空${suffix}`,
  }
}
