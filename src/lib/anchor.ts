import type { Cue } from './srt'

/**
 * 校准锚点：source 为某条字幕的“原始起始时间”（毫秒），
 * target 为用户期望它被映射到的目标时间（毫秒）。
 */
export interface Anchor {
  source: number
  target: number
}

/**
 * 构造严格递增的锚点列表。
 * source 唯一；target 必须与 source 同序且两两严格递增，否则返回 null。
 */
export function buildAnchors(pairs: Array<[number, number]>): Anchor[] | null {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0])
  const anchors: Anchor[] = []
  for (const [source, target] of sorted) {
    if (anchors.length > 0) {
      const prev = anchors[anchors.length - 1]
      if (source === prev.source || target <= prev.target) return null
    }
    anchors.push({ source, target })
  }
  return anchors
}

/**
 * 把一组（可能未排序的）锚点变为严格递增序列；无法构造时返回 null。
 * 供编辑/新增锚点时做合法性校验。
 */
export function tryMakeAnchors(pairs: Array<[number, number]>): Anchor[] | null {
  return buildAnchors(pairs)
}

/**
 * 单条时间戳的分段线性映射。
 * - 0 个锚点：恒等映射（保留原时间）
 * - 1 个锚点：整体平移 t + (target - source)
 * - 多个锚点：锚点之间线性插值；首尾沿最近区段的斜率外推
 */
export function mapTimestamp(t: number, anchors: Anchor[]): number {
  if (anchors.length === 0) return t
  if (anchors.length === 1) {
    return t + anchors[0].target - anchors[0].source
  }

  // 头部：沿第一区段斜率外推
  if (t <= anchors[0].source) {
    const a = anchors[0]
    const b = anchors[1]
    const slope = (b.target - a.target) / (b.source - a.source)
    return a.target + (t - a.source) * slope
  }

  // 尾部：沿最后区段斜率外推
  const last = anchors[anchors.length - 1]
  if (t >= last.source) {
    const prev = anchors[anchors.length - 2]
    const slope = (last.target - prev.target) / (last.source - prev.source)
    return last.target + (t - last.source) * slope
  }

  // 中间：相邻锚点线性插值
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]
    const b = anchors[i + 1]
    if (t >= a.source && t <= b.source) {
      const ratio = (t - a.source) / (b.source - a.source)
      return a.target + ratio * (b.target - a.target)
    }
  }
  return t
}

export interface MappedLine extends Cue {
  newStart: number
  newEnd: number
}

/** 对全部字幕应用映射，按原始顺序返回。 */
export function mapCues(cues: Cue[], anchors: Anchor[]): MappedLine[] {
  return cues.map((cue) => ({
    ...cue,
    newStart: mapTimestamp(cue.start, anchors),
    newEnd: mapTimestamp(cue.end, anchors),
  }))
}

export type IssueKind = 'negative' | 'nonpositive' | 'overlap'

export interface Issue {
  kind: IssueKind
  /** 另一条相关字幕的序号（overlap 时指向前一条）。 */
  withId?: string
}

/**
 * 校验映射结果。按映射后的起始时间排序后检查：
 * - 起始或结束时间为负
 * - 时长非正（newEnd <= newStart）
 * - 相邻字幕重叠（当前起始早于上一条结束）
 */
export function validateMapped(lines: MappedLine[]): Map<number, Issue[]> {
  const issues = new Map<number, Issue[]>()
  const add = (index: number, issue: Issue) => {
    const list = issues.get(index)
    if (list) list.push(issue)
    else issues.set(index, [issue])
  }

  for (const line of lines) {
    if (line.newStart < 0 || line.newEnd < 0) {
      add(line.index, { kind: 'negative' })
    }
    if (line.newEnd <= line.newStart) {
      add(line.index, { kind: 'nonpositive' })
    }
  }

  const ordered = [...lines].sort((a, b) => a.newStart - b.newStart)
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]
    const cur = ordered[i]
    // 仅当两条本身时长为正时重叠才构成“重叠”问题，避免重复标红
    if (cur.newStart < prev.newEnd && cur.newEnd > cur.newStart && prev.newEnd > prev.newStart) {
      add(cur.index, { kind: 'overlap', withId: prev.id })
    }
  }

  return issues
}

export const ISSUE_LABEL: Record<IssueKind, string> = {
  negative: '映射后出现负时间',
  nonpositive: '时长非正',
  overlap: '与相邻字幕重叠',
}
