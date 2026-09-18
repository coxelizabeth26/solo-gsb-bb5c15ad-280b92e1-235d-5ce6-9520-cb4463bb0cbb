import type { MappedLine } from './anchor'

/**
 * 视频同步预览的纯逻辑：根据“校准后”的起止时间计算某一播放时刻
 * 应当叠加显示的字幕，以及点击字幕行时的跳转目标。
 * 与 DOM / 播放器无关，便于在 Node 中直接断言检查。
 */

/**
 * 一条校准后字幕在播放时间轴上的有效区间 [start, end)（毫秒）。
 * 负时间不提前显示：起始时间钳到 0；结束时间保持原样
 * （整体为负或时长非正的字幕因此自然永不显示）。
 */
export function effectiveRange(line: Pick<MappedLine, 'newStart' | 'newEnd'>): [number, number] {
  return [Math.max(0, line.newStart), line.newEnd]
}

/**
 * 计算播放时间 timeMs（毫秒）应显示的字幕。
 * - 以校准后的起止时间为准，区间为左闭右开 [start, end)；
 * - 多条字幕时间重叠时全部返回，按字幕原始顺序（index）排列；
 * - 负时间字幕不提前显示（见 effectiveRange）。
 */
export function activeLines(lines: MappedLine[], timeMs: number): MappedLine[] {
  return lines
    .filter((line) => {
      const [start, end] = effectiveRange(line)
      return timeMs >= start && timeMs < end
    })
    .sort((a, b) => a.index - b.index)
}

/**
 * 点击字幕行后的跳转目标（秒）。
 * 以校准后起始时间为准：负值钳到 0；已知视频时长时，超出时长则停在末尾。
 * 时长未知（元数据未加载）时不做末尾钳制。
 */
export function seekTargetSec(newStartMs: number, durationSec: number): number {
  const t = Math.max(0, newStartMs) / 1000
  if (!Number.isFinite(durationSec) || durationSec <= 0) return t
  return Math.min(t, durationSec)
}
