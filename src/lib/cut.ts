import type { MappedLine } from './anchor'
import { parseTime, formatTime } from './time'

/**
 * “删减清单重排”：主轨完成锚点校准后，导入一个 JSON 数组，
 * 每项含 start / end 两个 SRT 时间字符串（end > start），表示校准后时间轴上
 * 需要删除的片段。处理流程：
 * 1. 按时间排序并把相交或相接（端点相等）的删减段合并；
 * 2. 从校准后的每条字幕区间中扣除合并后的删减段：
 *    - 完全落入删减段的字幕移除；
 *    - 跨越删减边界的字幕拆成各个非空片段并保留原文本；
 *    - 其余片段按此前累计删减时长向前平移。
 * 锚点变化后由上层基于校准结果实时重算，本模块不触碰锚点与双语合并状态。
 */

/** 一个合并后的删减区间（毫秒，校准后时间轴）。 */
export interface CutRange {
  start: number
  end: number
  /** 清单中的原始时间字符串（合并段取排序后首段 / 末段），供界面展示。 */
  rawStart: string
  rawEnd: string
}

/** 清单中的一项（已校验通过）。 */
export interface CutItem {
  start: string
  end: string
}

export type CutErrorCode =
  | 'invalid-json'
  | 'invalid-shape'
  | 'invalid-item'
  | 'empty-list'

export interface CutError {
  code: CutErrorCode
  message: string
}

export interface CutParseSuccess {
  items: CutItem[]
}

export type CutParseResult = CutParseSuccess | { errors: CutError[] }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 解析并严格校验删减清单。顶层必须是 JSON 数组；逐项收集错误
 * （非法 JSON / 顶层不是数组时直接拒绝）。任何一项非法都会返回全部错误，
 * 由上层保留上一次有效结果不被覆盖。
 */
export function parseCutList(content: string): CutParseResult {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return {
      errors: [{ code: 'invalid-json', message: '删减清单不是合法的 JSON，无法解析。' }],
    }
  }

  if (!Array.isArray(data)) {
    return {
      errors: [{ code: 'invalid-shape', message: '删减清单结构畸形：顶层必须是 JSON 数组。' }],
    }
  }

  const errors: CutError[] = []
  const items: CutItem[] = []
  for (const [i, raw] of data.entries()) {
    const bad = (msg: string) =>
      errors.push({ code: 'invalid-item', message: `第 ${i + 1} 项${msg}` })

    if (!isPlainObject(raw)) {
      bad('结构畸形：必须是含 start / end 的对象。')
      continue
    }
    for (const key of Object.keys(raw)) {
      if (key !== 'start' && key !== 'end') bad(`存在未知字段“${key}”。`)
    }
    const { start, end } = raw
    if (typeof start !== 'string') {
      bad('的 start 缺失或不是字符串。')
      continue
    }
    if (typeof end !== 'string') {
      bad('的 end 缺失或不是字符串。')
      continue
    }
    const startMs = parseTime(start)
    const endMs = parseTime(end)
    if (startMs === null || startMs < 0) {
      bad(`的 start“${start}”无法解析（应为 HH:MM:SS,mmm）。`)
      continue
    }
    if (endMs === null || endMs < 0) {
      bad(`的 end“${end}”无法解析（应为 HH:MM:SS,mmm）。`)
      continue
    }
    if (!(endMs > startMs)) {
      bad(`的 end 必须严格晚于 start（start=${start}，end=${end}）。`)
      continue
    }
    items.push({ start, end })
  }

  if (items.length === 0) {
    errors.push({
      code: 'empty-list',
      message: '删减清单不包含任何有效删减段，没有可应用的内容。',
    })
  }
  if (errors.length > 0) return { errors }
  return { items }
}

/**
 * 把校验通过的清单项按起始时间排序，并合并所有相交或相接（端点相等）的区间。
 */
export function mergeCuts(items: CutItem[]): CutRange[] {
  const sorted = [...items]
    .map((it): CutRange => ({
      start: parseTime(it.start) ?? 0,
      end: parseTime(it.end) ?? 0,
      rawStart: it.start,
      rawEnd: it.end,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const merged: CutRange[] = []
  for (const range of sorted) {
    const prev = merged[merged.length - 1]
    // 相接（cur.start === prev.end）也合并
    if (prev && range.start <= prev.end) {
      if (range.end > prev.end) {
        prev.end = range.end
        prev.rawEnd = range.rawEnd
      }
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * 某条校准后字幕在删减后的处置结果：
 * - removed：完全落入删减段（无任何非空残留），整条移除；
 * - split：扣除后产生多个非空片段，原文本在每个片段上各保留一份；
 * - shifted：仅有一个残留片段，且因此前累计删减需要向前平移；
 * - kept：仅有一个残留片段且无需平移（区间原样保留）。
 */
export type CutLineStatus = 'removed' | 'split' | 'shifted' | 'kept'

/** 一条字幕扣除删减段后的一个非空片段（时间均为输出时间轴上的毫秒）。 */
export interface CutFragment {
  /** 扣除后、平移前的校准时间轴区间。 */
  segStart: number
  segEnd: number
  /** 输出时间轴区间（按此前累计删减时长平移）。 */
  outStart: number
  outEnd: number
  /** 该片段起点之前的累计删减时长（ms）。 */
  shift: number
  text: string
}

export interface CutLineResult {
  /** 对应 MappedLine.index。 */
  index: number
  /** 对应原始字幕序号文本。 */
  id: string
  /** 校准后（扣除前）区间。 */
  oldStart: number
  oldEnd: number
  text: string
  status: CutLineStatus
  fragments: CutFragment[]
}

export interface CutPlan {
  ranges: CutRange[]
  results: CutLineResult[]
  removed: number
  split: number
  shifted: number
  kept: number
  /** 输出片段总数（即导出 SRT 的条目数）。 */
  fragmentCount: number
  byIndex: Map<number, CutLineResult>
}

/** 严格位于时间 t 之前（删减段末端 === t 不计入）的删减段总时长。 */
export function removedBefore(ranges: CutRange[], t: number): number {
  let total = 0
  for (const r of ranges) {
    if (r.end <= t) {
      total += r.end - r.start
    } else {
      break
    }
  }
  return total
}

/**
 * 从校准后的字幕区间中扣除合并后的删减段，返回逐条处置结果。
 * 结果按主轨文件顺序排列；每条的片段按时间顺序排列。
 */
export function computeCutPlan(lines: MappedLine[], ranges: CutRange[]): CutPlan {
  const ordered = [...ranges].sort((a, b) => a.start - b.start)
  const results: CutLineResult[] = []
  let removed = 0
  let split = 0
  let shifted = 0
  let kept = 0
  let fragmentCount = 0

  for (const line of lines) {
    const lo = line.newStart
    const hi = line.newEnd

    // 非正时长字幕没有可拆分的区间：与删减段相交（或落入）即移除，否则原样保留。
    if (!(hi > lo)) {
      const intersects = ordered.some((r) => lo < r.end && hi > r.start)
      if (intersects) {
        removed++
        results.push({
          index: line.index,
          id: line.id,
          oldStart: lo,
          oldEnd: hi,
          text: line.text,
          status: 'removed',
          fragments: [],
        })
      } else {
        kept++
        results.push({
          index: line.index,
          id: line.id,
          oldStart: lo,
          oldEnd: hi,
          text: line.text,
          status: 'kept',
          fragments: [
            { segStart: lo, segEnd: hi, outStart: lo, outEnd: hi, shift: 0, text: line.text },
          ],
        })
        fragmentCount++
      }
      continue
    }

    // 用删减段边界把 [lo, hi) 切成非空片段，删减段内部不产生片段。
    const fragments: CutFragment[] = []
    let cursor = lo
    for (const r of ordered) {
      if (r.end <= lo) continue
      if (r.start >= hi) break
      if (r.start > cursor) {
        const shift = removedBefore(ordered, cursor)
        fragments.push({
          segStart: cursor,
          segEnd: r.start,
          outStart: cursor - shift,
          outEnd: r.start - shift,
          shift,
          text: line.text,
        })
      }
      cursor = Math.max(cursor, r.end)
    }
    const tailShift = removedBefore(ordered, cursor)
    if (cursor < hi) {
      fragments.push({
        segStart: cursor,
        segEnd: hi,
        outStart: cursor - tailShift,
        outEnd: hi - tailShift,
        shift: tailShift,
        text: line.text,
      })
    }

    let status: CutLineStatus
    if (fragments.length === 0) {
      status = 'removed'
      removed++
    } else if (fragments.length > 1) {
      status = 'split'
      split++
      fragmentCount += fragments.length
    } else if (fragments[0].shift > 0) {
      status = 'shifted'
      shifted++
      fragmentCount++
    } else {
      status = 'kept'
      kept++
      fragmentCount++
    }

    results.push({
      index: line.index,
      id: line.id,
      oldStart: lo,
      oldEnd: hi,
      text: line.text,
      status,
      fragments,
    })
  }

  return {
    ranges: ordered,
    results,
    removed,
    split,
    shifted,
    kept,
    fragmentCount,
    byIndex: new Map(results.map((r) => [r.index, r])),
  }
}

/**
 * 导出删减重排后的独立 SRT：按结果顺序（主轨文件顺序、片段时间顺序）
 * 从 1 重新编号，文本原样保留；时间码四舍五入为整数毫秒。
 */
export function buildCutSrt(plan: CutPlan): string {
  const blocks: string[] = []
  let no = 1
  for (const result of plan.results) {
    for (const f of result.fragments) {
      blocks.push(
        `${no}\n${formatTime(Math.round(f.outStart))} --> ${formatTime(Math.round(f.outEnd))}\n${f.text}`,
      )
      no++
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') + '\n' : ''
}
