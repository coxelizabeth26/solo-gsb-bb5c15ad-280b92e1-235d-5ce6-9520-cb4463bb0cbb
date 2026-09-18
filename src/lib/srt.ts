import { formatTime, parseTime } from './time'

/** 一条原始字幕。id 保留文件中的序号文本，index 为文件内从 0 开始的顺序。 */
export interface Cue {
  id: string
  index: number
  start: number
  end: number
  text: string
}

export interface ParseResult {
  cues: Cue[]
  /** 解析过程中跳过的块数量（时间码非法等）。 */
  skipped: number
}

/**
 * 解析 SRT 文本。兼容 CRLF/LF、空块、BOM，以及点号毫秒分隔符。
 * 序号缺失时按顺序补号。时间码无法解析的块会被跳过并计入 skipped。
 */
export function parseSrt(content: string): ParseResult {
  const text = content.replace(/^\uFEFF/, '')
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const cues: Cue[] = []
  let skipped = 0
  let order = 0

  for (const rawBlock of blocks) {
    const block = rawBlock.trim()
    if (!block) continue

    const lines = block.split('\n').map((l) => l.trimEnd())
    let cursor = 0
    let id = String(order + 1)

    // 可选的序号行
    if (!lines[0]?.includes('-->')) {
      id = (lines[0] ?? '').trim() || id
      cursor = 1
    }

    const timing = lines[cursor] ?? ''
    const tm = /^(.*?)\s*-->\s*(.*?)$/.exec(timing.trim())
    if (!tm) {
      skipped++
      order++
      continue
    }

    const start = parseTime(tm[1] ?? '')
    const end = parseTime(tm[2] ?? '')
    if (start === null || end === null) {
      skipped++
      order++
      continue
    }

    const body = lines.slice(cursor + 1).join('\n').trim()
    cues.push({
      id: id || String(order + 1),
      index: order,
      start,
      end,
      text: body,
    })
    order++
  }

  return { cues, skipped }
}

export interface MappedCue {
  newStart: number
  newEnd: number
}

/** 将映射后的字幕序列化为新的 SRT 文本，序号与文本保持原样。 */
export function buildSrt(cues: Array<Cue & MappedCue>): string {
  const ordered = [...cues].sort((a, b) => a.index - b.index)
  return (
    ordered
      .map(
        (cue) =>
          `${cue.id}\n${formatTime(cue.newStart)} --> ${formatTime(cue.newEnd)}\n${cue.text}`,
      )
      .join('\n\n') + '\n'
  )
}
