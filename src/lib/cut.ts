import type { MappedLine } from './anchor'
import { formatTime, parseTime } from './time'

/**
 * “删减清单重排”：主轨完成锚点校准后，导入一份 JSON 数组形式的删减清单
 * （每项含 start、end 两个 SRT 时间字符串，且 end > start），
 * 先按时间排序并合并相交或相接的区间，再从校准后的每条字幕区间中扣除它们：
 * - 完全落入删减段的字幕被移除；
 * - 跨越删减边界的字幕拆成各个非空片段（保留原文本）；
 * - 其余片段按“此前累计删减时长”向前平移，得到删减后的新时间轴。
 *
 * 本模块只做纯计算：输入为校准后的字幕区间（MappedLine），
 * 不触碰锚点与双语合并状态；锚点变化后由调用方用新的 lines 重新调用即可。
 */

/** 一个删减区间（毫秒，左闭右开）。 */
export interface CutRange {
  start: number
  end: number
}

/** 清单中某一项的校验错误。 */
export interface CutItemError {
  /** 清单中的项序号（从 1 开始）；0 表示整个文件级错误。 */
  item: number
  message: string
}

export type CutListParse =
  | { itemCount: number; ranges: CutRange[] }
  | { errors: CutItemError[] }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 解析并逐项校验删减清单。
 * - 全部合法：返回原始项数与“已排序并合并（相交或相接）”的区间；
 * - 任一项非法：返回全部逐项错误（合法项不影响其余项的报错定位），
 *   由调用方保留上次有效结果、不覆盖。
 */
export function parseCutList(content: string): CutListParse {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return { errors: [{ item: 0, message: '文件不是合法的 JSON，无法解析。' }] }
  }
  if (!Array.isArray(data)) {
    return { errors: [{ item: 0, message: '清单结构畸形：顶层必须是 JSON 数组。' }] }
  }

  const errors: CutItemError[] = []
  const raw: CutRange[] = []
  data.forEach((item, i) => {
    const itemNo = i + 1
    if (!isPlainObject(item)) {
      errors.push({ item: itemNo, message: '必须是对象，且含 start、end 两个 SRT 时间字符串。' })
      return
    }
    const { start, end } = item
    if (typeof start !== 'string') {
      errors.push({ item: itemNo, message: 'start 缺失或不是字符串（应为 HH:MM:SS,mmm）。' })
      return
    }
    if (typeof end !== 'string') {
      errors.push({ item: itemNo, message: 'end 缺失或不是字符串（应为 HH:MM:SS,mmm）。' })
      return
    }
    const s = parseTime(start)
    if (s === null) {
      errors.push({ item: itemNo, message: `start“${start}”无法解析（应为 HH:MM:SS,mmm）。` })
      return
    }
    const e = parseTime(end)
    if (e === null) {
      errors.push({ item: itemNo, message: `end“${end}”无法解析（应为 HH:MM:SS,mmm）。` })
      return
    }
    if (e <= s) {
      errors.push({ item: itemNo, message: `end 必须大于 start（${start} → ${end}）。` })
      return
    }
    raw.push({ start: s, end: e })
  })

  if (errors.length > 0) return { errors }
  return { itemCount: data.length, ranges: mergeRanges(raw) }
}

/** 按起始时间排序，并合并相交或相接（端点相连）的区间。 */
export function mergeRanges(ranges: CutRange[]): CutRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: CutRange[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end
    } else {
      merged.push({ start: r.start, end: r.end })
    }
  }
  return merged
}

/**
 * 从区间 [s, e) 中扣除已合并的删减区间，返回剩余的非空片段（按时间升序）。
 * 与删减段仅端点相接不算相交，片段保持不变。
 */
export function subtractRanges(
  s: number,
  e: number,
  ranges: CutRange[],
): Array<[number, number]> {
  const parts: Array<[number, number]> = []
  let cur = s
  for (const r of ranges) {
    if (r.end <= cur) continue
    if (r.start >= e) break
    if (r.start > cur) parts.push([cur, Math.min(r.start, e)])
    cur = Math.max(cur, r.end)
    if (cur >= e) break
  }
  if (cur < e) parts.push([cur, e])
  return parts
}

export type CutStatus = 'removed' | 'split' | 'shifted' | 'unchanged'

export const CUT_STATUS_LABEL: Record<CutStatus, string> = {
  removed: '移除',
  split: '拆分',
  shifted: '位移',
  unchanged: '不变',
}

/** 一个保留下来的输出片段。 */
export interface CutFragment {
  /** 来源字幕的 Cue.index 与序号文本。 */
  cueIndex: number
  cueId: string
  /** 原文本（拆分片段完整保留）。 */
  text: string
  /** 校准后、删减前的片段区间。 */
  fromStart: number
  fromEnd: number
  /** 向前平移量（毫秒，>= 0）：此前累计删减时长。 */
  shift: number
  /** 输出区间 = 片段区间 − shift。 */
  newStart: number
  newEnd: number
  /** 在导出文件中的序号（按结果顺序从 1 编号）。 */
  outNo: number
}

/** 一条校准后字幕在删减重排中的结果。 */
export interface CutEntry {
  cueIndex: number
  cueId: string
  text: string
  /** 校准后区间（删减前）。 */
  start: number
  end: number
  status: CutStatus
  fragments: CutFragment[]
}

export interface CutPlan {
  /** 合并后的删减区间。 */
  ranges: CutRange[]
  /** 全部删减区间的总时长（毫秒）。 */
  totalCutMs: number
  entries: CutEntry[]
  /** 全部输出片段，按结果顺序排列（即导出顺序）。 */
  output: CutFragment[]
  removedCount: number
  splitCount: number
  shiftedCount: number
  unchangedCount: number
}

/**
 * 计算删减重排结果。ranges 允许未排序/未合并，内部会先合并。
 *
 * 平移规则：片段 [ps, pe) 不与任何删减区间相交，故其整体平移量 =
 * “end <= ps 的删减区间”的总时长（此前累计删减时长），
 * 输出区间为 [ps - shift, pe - shift)。平移量随时间单调不减，
 * 因此片段之间的先后顺序与不重叠性在输出时间轴上保持。
 */
export function computeCutPlan(lines: MappedLine[], ranges: CutRange[]): CutPlan {
  const merged = mergeRanges(ranges)

  // 前缀和：cum[i] 为前 i 个删减区间的总时长
  const cum: number[] = new Array(merged.length + 1)
  cum[0] = 0
  for (let i = 0; i < merged.length; i++) {
    cum[i + 1] = cum[i] + (merged[i].end - merged[i].start)
  }
  /** t 之前（含恰好相接）的累计删减时长。 */
  const shiftAt = (t: number): number => {
    let lo = 0
    let hi = merged.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (merged[mid].end <= t) lo = mid + 1
      else hi = mid
    }
    return cum[lo]
  }

  const entries: CutEntry[] = []
  const output: CutFragment[] = []
  let removedCount = 0
  let splitCount = 0
  let shiftedCount = 0
  let unchangedCount = 0

  for (const line of lines) {
    const parts = subtractRanges(line.newStart, line.newEnd, merged)
    const fragments: CutFragment[] = parts.map(([ps, pe]) => {
      const shift = shiftAt(ps)
      return {
        cueIndex: line.index,
        cueId: line.id,
        text: line.text,
        fromStart: ps,
        fromEnd: pe,
        shift,
        newStart: ps - shift,
        newEnd: pe - shift,
        outNo: 0, // 扁平化后统一编号
      }
    })

    let status: CutStatus
    if (fragments.length === 0) {
      status = 'removed'
      removedCount++
    } else if (
      fragments.length === 1 &&
      fragments[0].fromStart === line.newStart &&
      fragments[0].fromEnd === line.newEnd
    ) {
      status = fragments[0].shift > 0 ? 'shifted' : 'unchanged'
      if (status === 'shifted') shiftedCount++
      else unchangedCount++
    } else {
      status = 'split'
      splitCount++
    }

    entries.push({
      cueIndex: line.index,
      cueId: line.id,
      text: line.text,
      start: line.newStart,
      end: line.newEnd,
      status,
      fragments,
    })
    output.push(...fragments)
  }

  // 按结果顺序从 1 编号（与导出序号一致）
  output.forEach((f, i) => {
    f.outNo = i + 1
  })

  return {
    ranges: merged,
    totalCutMs: cum[merged.length],
    entries,
    output,
    removedCount,
    splitCount,
    shiftedCount,
    unchangedCount,
  }
}

/**
 * 导出删减重排后的独立 SRT：
 * - 仅包含保留下来的片段，按结果顺序从 1 重编号；
 * - 文本原样保留（含拆分片段）；
 * - 校准时间码可能含小数毫秒，导出时四舍五入为整数毫秒。
 */
export function buildCutSrt(plan: CutPlan): string {
  return (
    plan.output
      .map(
        (f, i) =>
          `${i + 1}\n${formatTime(Math.round(f.newStart))} --> ${formatTime(Math.round(f.newEnd))}\n${f.text}`,
      )
      .join('\n\n') + '\n'
  )
}
