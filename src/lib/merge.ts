import type { MappedLine } from './anchor'
import type { Cue } from './srt'
import { formatTime } from './time'

/**
 * “双语字幕合并”：主 SRT 已按锚点校准后，导入第二份 SRT（次轨），
 * 在“校准后的主时间轴”与次轨原始时间轴之间做顺序保持的一对一匹配。
 *
 * 候选合法性（legalEdge）：
 * - 两条字幕区间有正重叠；
 * - 重叠时长不少于两条字幕中“较短者”时长的 50%；
 * - 任一字幕时长非正时不构成候选。
 *
 * 全部合法匹配构成一张序列对齐表，优化目标依次为：
 * 1. 最大化总重叠毫秒数；
 * 2. 最小化起始时间差（绝对值）总和；
 * 3. 仍并列时，选择次轨序号序列字典序更早的方案。
 */

/** 一对匹配：主轨（校准后区间）与次轨（原始区间）。 */
export interface MergeEdge {
  /** 主轨 Cue.index。 */
  mainIndex: number
  /** 次轨 Cue.index。 */
  secIndex: number
  /** 正重叠时长（ms）。 */
  overlap: number
  /** 起始时间差绝对值（ms）。 */
  startDelta: number
}

export interface MergePlan {
  /** 匹配对，按主轨顺序排列（次轨序号同样严格递增）。 */
  edges: MergeEdge[]
  totalOverlap: number
  totalStartDelta: number
  /** 未匹配的主轨 Cue.index 列表（按文件顺序）。 */
  unmatchedMain: number[]
  /** 未匹配的次轨 Cue.index 列表（按文件顺序）。 */
  unmatchedSecondary: number[]
  byMain: Map<number, MergeEdge>
  bySec: Map<number, MergeEdge>
}

/** 区间结构（主轨用校准后起止，次轨用原始起止）。 */
export interface Interval {
  start: number
  end: number
}

/**
 * 判定一对字幕是否为合法候选；合法时返回重叠时长与起始时间差。
 */
export function legalEdge(
  a: Interval,
  b: Interval,
): { overlap: number; startDelta: number } | null {
  const durA = a.end - a.start
  const durB = b.end - b.start
  // 任一方时长非正（负时间/零时长字幕）不构成候选
  if (!(durA > 0) || !(durB > 0)) return null
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start)
  if (!(overlap > 0)) return null
  if (overlap * 2 < Math.min(durA, durB)) return null
  return { overlap, startDelta: Math.abs(a.start - b.start) }
}

/** DP 状态数上限（(n+1)×(m+1)），超出时直接报错，避免浏览器内存耗尽。 */
export const MERGE_MAX_CELLS = 12_000_000

/**
 * 计算顺序保持的一对一最优匹配（后缀动态规划）。
 *
 * best(i,j) 表示主轨第 i 条起、次轨第 j 条起的后缀子问题最优得分，
 * 每个状态有三种转移：匹配 (i,j)（须为合法候选）、跳过主轨 i、跳过次轨 j。
 * 填表与重建共用同一候选优先序（匹配 > 跳过主轨 > 跳过次轨），
 * 使得“前两级得分完全并列”时重建出次轨序号序列字典序最早的方案。
 */
export function computeMergePlan(lines: MappedLine[], secCues: Cue[]): MergePlan {
  const n = lines.length
  const m = secCues.length
  const cells = (n + 1) * (m + 1)
  if (cells > MERGE_MAX_CELLS) {
    throw new Error(
      `主轨 ${n} 条 × 次轨 ${m} 条的匹配规模过大（状态数超过 ${MERGE_MAX_CELLS.toLocaleString()}），请拆分字幕后重试。`,
    )
  }

  // 边界行/列（i===n 或 j===m）保持 0 分
  const bestOv = new Float64Array(cells)
  const bestDf = new Float64Array(cells)
  const idx = (i: number, j: number): number => i * (m + 1) + j

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const cur = idx(i, j)
      // 候选按“字典序优先序”排列：匹配 (i,j) → 跳过主轨 i → 跳过次轨 j；
      // 仅当严格更优（重叠更大，或重叠相同且时差更小）时才替换，
      // 故分数完全并列时保留排在最前的候选。
      const leg = legalEdge(lines[i], secCues[j])
      if (leg) {
        const next = idx(i + 1, j + 1)
        bestOv[cur] = leg.overlap + bestOv[next]
        bestDf[cur] = leg.startDelta + bestDf[next]
      } else {
        const skipPri = idx(i + 1, j)
        bestOv[cur] = bestOv[skipPri]
        bestDf[cur] = bestDf[skipPri]
      }

      const skipPri = idx(i + 1, j)
      if (
        bestOv[skipPri] > bestOv[cur] ||
        (bestOv[skipPri] === bestOv[cur] && bestDf[skipPri] < bestDf[cur])
      ) {
        bestOv[cur] = bestOv[skipPri]
        bestDf[cur] = bestDf[skipPri]
      }

      const skipSec = idx(i, j + 1)
      if (
        bestOv[skipSec] > bestOv[cur] ||
        (bestOv[skipSec] === bestOv[cur] && bestDf[skipSec] < bestDf[cur])
      ) {
        bestOv[cur] = bestOv[skipSec]
        bestDf[cur] = bestDf[skipSec]
      }
    }
  }

  // 贪心重建：与填表优先序一致 → 匹配 → 跳过主轨 → 跳过次轨。
  const edges: MergeEdge[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const cur = idx(i, j)
    const leg = legalEdge(lines[i], secCues[j])
    if (leg) {
      const next = idx(i + 1, j + 1)
      const ov = leg.overlap + bestOv[next]
      const df = leg.startDelta + bestDf[next]
      if (ov === bestOv[cur] && df === bestDf[cur]) {
        edges.push({
          mainIndex: lines[i].index,
          secIndex: secCues[j].index,
          overlap: leg.overlap,
          startDelta: leg.startDelta,
        })
        i++
        j++
        continue
      }
    }
    const skipPri = idx(i + 1, j)
    if (bestOv[skipPri] === bestOv[cur] && bestDf[skipPri] === bestDf[cur]) {
      i++
      continue
    }
    j++
  }

  const byMain = new Map<number, MergeEdge>()
  const bySec = new Map<number, MergeEdge>()
  for (const edge of edges) {
    byMain.set(edge.mainIndex, edge)
    bySec.set(edge.secIndex, edge)
  }

  const unmatchedMain: number[] = []
  const unmatchedSecondary: number[] = []
  for (const line of lines) {
    if (!byMain.has(line.index)) unmatchedMain.push(line.index)
  }
  for (const cue of secCues) {
    if (!bySec.has(cue.index)) unmatchedSecondary.push(cue.index)
  }

  return {
    edges,
    totalOverlap: bestOv[idx(0, 0)],
    totalStartDelta: bestDf[idx(0, 0)],
    unmatchedMain,
    unmatchedSecondary,
    byMain,
    bySec,
  }
}

/**
 * 导出双语 SRT：
 * - 沿用主轨校准后时间码与主文本；
 * - 已匹配的次轨文本追加为主文本的下一行；
 * - 未匹配主轨照常导出；未匹配次轨不写入（仅由界面提示）。
 *
 * 校准时间码可能因分段线性插值出现小数毫秒，导出时四舍五入为整数毫秒。
 */
export function buildMergedSrt(
  lines: MappedLine[],
  secCues: Cue[],
  plan: MergePlan,
): string {
  const secByIndex = new Map(secCues.map((cue) => [cue.index, cue]))
  const ordered = [...lines].sort((a, b) => a.index - b.index)
  return (
    ordered
      .map((line) => {
        const edge = plan.byMain.get(line.index)
        const secText = edge ? secByIndex.get(edge.secIndex)?.text : undefined
        const text = secText !== undefined ? `${line.text}\n${secText}` : line.text
        return (
          `${line.id}\n` +
          `${formatTime(Math.round(line.newStart))} --> ${formatTime(Math.round(line.newEnd))}\n` +
          text
        )
      })
      .join('\n\n') + '\n'
  )
}
