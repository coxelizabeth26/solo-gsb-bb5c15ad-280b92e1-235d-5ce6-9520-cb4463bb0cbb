import type { Anchor } from './anchor'
import type { Cue } from './srt'
import { formatTime, parseTime } from './time'

/**
 * “锚点方案”：把一次校准中所有锚点（原始时间、目标时间及对应字幕的
 * 规范化文本）导出为 JSON，以便在修订版 SRT（时间轴或条目顺序变化、
 * 但字幕文本大体保留）上复现同一套校准。
 */

export const PLAN_VERSION = 1

/**
 * 文本规范化：仅去除首尾空白、把连续空白（含换行、制表符等）合并为单个空格。
 * 导出与导入使用同一规则，保证“规范化文本相同”的比较确定一致。
 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export interface PlanAnchor {
  source: string
  target: string
  text: string
}

export interface AnchorPlan {
  version: typeof PLAN_VERSION
  anchors: PlanAnchor[]
}

export type PlanErrorCode =
  | 'invalid-json'
  | 'invalid-shape'
  | 'unknown-version'
  | 'invalid-anchor'
  | 'empty-anchors'

export interface PlanError {
  code: PlanErrorCode
  message: string
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 解析并严格校验锚点方案文件。
 * - 不是合法 JSON / 顶层结构畸形：invalid-json / invalid-shape
 * - 版本号缺失或非 1：unknown-version（未知版本一律拒绝）
 * - 任一字段类型或数值非法（含额外未知字段、时间码无法解析、为负、
 *   原始/目标时间不严格递增）：invalid-anchor
 * - 方案不含任何锚点：empty-anchors
 */
export function parsePlan(content: string): { plan: AnchorPlan } | { error: PlanError } {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return {
      error: {
        code: 'invalid-json',
        message: '方案文件不是合法的 JSON，无法解析。',
      },
    }
  }

  if (!isPlainObject(data)) {
    return {
      error: { code: 'invalid-shape', message: '方案文件结构畸形：顶层必须是对象。' },
    }
  }

  const topKeys = Object.keys(data)
  if (!topKeys.includes('version')) {
    return {
      error: { code: 'invalid-shape', message: '方案文件结构畸形：缺少版本号字段 version。' },
    }
  }
  if (data.version !== PLAN_VERSION) {
    return {
      error: {
        code: 'unknown-version',
        message: `方案版本${typeof data.version === 'number' ? ` v${data.version}` : ''}不受支持（本工具仅支持版本 ${PLAN_VERSION}），已拒绝导入。`,
      },
    }
  }
  for (const key of topKeys) {
    if (key !== 'version' && key !== 'anchors') {
      return {
        error: {
          code: 'invalid-shape',
          message: `方案文件结构畸形：存在未知的顶层字段“${key}”。`,
        },
      }
    }
  }

  if (!Array.isArray(data.anchors)) {
    return {
      error: {
        code: 'invalid-shape',
        message: '方案文件结构畸形：anchors 必须是数组。',
      },
    }
  }

  const anchors: PlanAnchor[] = []
  let prevSource = -1
  let prevTarget = -1
  for (const [i, raw] of data.anchors.entries()) {
    const bad = (msg: string): { error: PlanError } => ({
      error: {
        code: 'invalid-anchor',
        message: `第 ${i + 1} 个锚点${msg}`,
      },
    })
    if (!isPlainObject(raw)) return bad('结构畸形：必须是对象。')
    const keys = Object.keys(raw)
    for (const key of keys) {
      if (key !== 'source' && key !== 'target' && key !== 'text') {
        return bad(`存在未知字段“${key}”。`)
      }
    }
    const { source, target, text } = raw
    if (typeof source !== 'string') return bad('的原始时间 source 缺失或不是字符串。')
    if (typeof target !== 'string') return bad('的目标时间 target 缺失或不是字符串。')
    if (typeof text !== 'string') return bad('的字幕文本 text 缺失或不是字符串。')
    if (normalizeText(text) === '') return bad('的字幕文本为空。')

    const sourceMs = parseTime(source)
    const targetMs = parseTime(target)
    if (sourceMs === null || sourceMs < 0) {
      return bad(`的原始时间“${source}”无法解析（应为 HH:MM:SS,mmm）。`)
    }
    if (targetMs === null || targetMs < 0) {
      return bad(`的目标时间“${target}”无法解析（应为 HH:MM:SS,mmm）。`)
    }
    if (sourceMs <= prevSource) {
      return bad('的原始时间未严格递增（不可重复或递减）。')
    }
    if (targetMs <= prevTarget) {
      return bad('的目标时间未严格递增（不可重复或递减）。')
    }
    prevSource = sourceMs
    prevTarget = targetMs
    anchors.push({ source, target, text })
  }

  if (anchors.length === 0) {
    return {
      error: {
        code: 'empty-anchors',
        message: '方案文件不包含任何锚点，没有可导入的内容。',
      },
    }
  }

  return { plan: { version: PLAN_VERSION, anchors } }
}

/**
 * 把当前锚点序列化为方案 JSON 字符串。
 * 每个锚点必须能在当前字幕中按原始起始时间找到对应字幕，否则返回 null。
 */
export function serializePlan(cues: Cue[], anchors: Anchor[]): string | null {
  const cueByStart = new Map<number, Cue>()
  for (const cue of cues) {
    if (!cueByStart.has(cue.start)) cueByStart.set(cue.start, cue)
  }
  const planAnchors: PlanAnchor[] = []
  for (const a of anchors) {
    const cue = cueByStart.get(a.source)
    if (!cue) return null
    planAnchors.push({
      source: formatTime(a.source),
      target: formatTime(a.target),
      text: normalizeText(cue.text),
    })
  }
  const plan: AnchorPlan = { version: PLAN_VERSION, anchors: planAnchors }
  return JSON.stringify(plan, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// 导入预览：在“当前（修订版）字幕”中为方案中的每个锚点寻找落点
// ---------------------------------------------------------------------------

export type MatchStatus = 'direct' | 'migrated' | 'conflict'
export type ConflictReason = 'missing' | 'duplicate' | 'order' | 'target-order'

export const CONFLICT_LABEL: Record<ConflictReason, string> = {
  missing: '文本缺失：当前字幕中找不到该文本',
  duplicate: '文本重复：该文本在当前字幕中不唯一',
  order: '破坏锚点顺序：迁移后无法保持锚点顺序',
  'target-order': '目标时间冲突：迁移后目标时间不再严格递增',
}

export interface PreviewEntry {
  /** 方案中的原始时间（ms）。 */
  sourceMs: number
  /** 方案中的目标时间（ms）。 */
  targetMs: number
  /** 方案中记录的规范化文本。 */
  text: string
  status: MatchStatus
  /** 非冲突时，匹配到的当前字幕 index（Cue.index）。 */
  cueIndex: number | null
  conflictReason: ConflictReason | null
}

export interface PlanPreview {
  entries: PreviewEntry[]
  validCount: number
  conflictCount: number
  /** 应用全部有效项后得到的锚点（已按匹配后的原始时间排序）；全部冲突时为 null。 */
  anchors: Anchor[] | null
}

/**
 * 匹配规则（逐项）：
 * 1. 当前字幕中存在“原始起始时间与规范化文本均相同”的唯一条目 → 直接匹配。
 * 2. 否则，若规范化文本在当前全部字幕中恰好出现一次 → 迁移到该条目；
 *    但迁移结果不得破坏锚点顺序，否则该迁移项标记为冲突。
 * 3. 文本出现 0 次 → 缺失冲突；出现多次（且未被规则 1 命中）→ 重复冲突。
 * 4. 全部匹配完成后，有效项的目标时间必须随匹配后的原始时间严格递增，
 *    否则破坏递增的迁移项标记为冲突。
 */
export function previewPlan(plan: AnchorPlan, cues: Cue[]): PlanPreview {
  // 按“原始起始时间 + 规范化文本”索引当前字幕，并统计规范化文本出现次数
  const exact = new Map<string, Cue>()
  const normCount = new Map<string, number>()
  const byNorm = new Map<string, Cue>()
  for (const cue of cues) {
    const norm = normalizeText(cue.text)
    exact.set(`${cue.start}|${norm}`, cue)
    normCount.set(norm, (normCount.get(norm) ?? 0) + 1)
    if (!byNorm.has(norm)) byNorm.set(norm, cue)
  }

  const entries: PreviewEntry[] = plan.anchors.map((pa) => {
    const sourceMs = parseTime(pa.source) ?? -1
    const targetMs = parseTime(pa.target) ?? -1
    const norm = normalizeText(pa.text)

    const exactCue = exact.get(`${sourceMs}|${norm}`)
    if (exactCue) {
      return {
        sourceMs,
        targetMs,
        text: norm,
        status: 'direct',
        cueIndex: exactCue.index,
        conflictReason: null,
      }
    }

    const count = normCount.get(norm) ?? 0
    if (count === 0) {
      return {
        sourceMs,
        targetMs,
        text: norm,
        status: 'conflict',
        cueIndex: null,
        conflictReason: 'missing',
      }
    }
    if (count > 1) {
      return {
        sourceMs,
        targetMs,
        text: norm,
        status: 'conflict',
        cueIndex: null,
        conflictReason: 'duplicate',
      }
    }

    // 文本唯一：候选迁移，顺序约束在两轮扫描中裁决
    return {
      sourceMs,
      targetMs,
      text: norm,
      status: 'migrated',
      cueIndex: byNorm.get(norm)!.index,
      conflictReason: null,
    }
  })

  const demote = (i: number, reason: ConflictReason) => {
    entries[i] = { ...entries[i], status: 'conflict', cueIndex: null, conflictReason: reason }
  }

  const cueStart = new Map(cues.map((c) => [c.index, c.start]))

  // 顺序约束：迁移后匹配到的“原始起始时间”必须严格递增（即不破坏锚点顺序）。
  // 直接匹配项视为锚定不降格；正常导出的方案中其时间天然递增，故只裁决迁移项。
  // 正向扫描：迁移项必须晚于前一个有效锚点。
  let prevStart = -1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.status === 'conflict') continue
    const start = cueStart.get(e.cueIndex!)!
    if (start <= prevStart) {
      if (e.status === 'migrated') demote(i, 'order')
    } else {
      prevStart = start
    }
  }
  // 反向扫描：迁移项必须早于后一个有效锚点。
  let nextStart = Number.POSITIVE_INFINITY
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.status === 'conflict') continue
    const start = cueStart.get(e.cueIndex!)!
    if (start >= nextStart) {
      if (e.status === 'migrated') demote(i, 'order')
    } else {
      nextStart = start
    }
  }
  const isOk = (e: PreviewEntry) => e.status !== 'conflict'
  // 迭代裁决：一旦有迁移项被降格，按位置排序后的相邻关系会变化，需要重新检查。
  for (let guard = 0; guard < entries.length; guard++) {
    const ordered = entries
      .filter(isOk)
      .sort(
        (a, b) => cueStart.get(a.cueIndex!)! - cueStart.get(b.cueIndex!)!,
      )
    let offender: PreviewEntry | null = null
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].targetMs <= ordered[i - 1].targetMs) {
        // 直接匹配是“锚定”的；正常导出的方案中破坏递增的只会是迁移项
        offender = ordered[i].status === 'migrated' ? ordered[i] : null
        break
      }
    }
    if (!offender) break
    demote(entries.indexOf(offender), 'target-order')
  }

  const finalValid = entries.filter(isOk)
  const pairs: Array<[number, number]> = finalValid.map((e) => [
    cueStart.get(e.cueIndex!)!,
    e.targetMs,
  ])
  // 防御性校验：经过上述裁决后应必然成立
  const anchors: Anchor[] | null = (() => {
    const sorted = [...pairs].sort((a, b) => a[0] - b[0])
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i][0] === sorted[i - 1][0] || sorted[i][1] <= sorted[i - 1][1]) return null
    }
    return sorted.map(([source, target]) => ({ source, target }))
  })()

  return {
    entries,
    validCount: finalValid.length,
    conflictCount: entries.length - finalValid.length,
    anchors,
  }
}
