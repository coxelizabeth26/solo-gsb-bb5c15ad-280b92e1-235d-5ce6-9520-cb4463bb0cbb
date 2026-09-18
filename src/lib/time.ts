/**
 * SRT 时间格式与毫秒之间的转换。
 * SRT 标准格式为 HH:MM:SS,mmm（解析时同时兼容点号分隔符 mmm）。
 */

const TIME_RE = /^(\d{1,2}):([0-5]\d):([0-5]\d)[.,](\d{1,3})$/

/** 将 "HH:MM:SS,mmm" 解析为毫秒；无法解析时返回 null。 */
export function parseTime(input: string): number | null {
  const m = TIME_RE.exec(input.trim())
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  const seconds = Number(m[3])
  // 1 位或 2 位毫秒分别按 10/100 放大
  const frac = m[4]
  const millis = Number(frac.padEnd(3, '0'))
  if (hours > 99) return null
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
}

/** 将毫秒格式化为 SRT 时间字符串 "HH:MM:SS,mmm"，负值使用 "-" 前缀。 */
export function formatTime(ms: number): string {
  const negative = ms < 0
  let value = Math.abs(ms)
  const millis = value % 1000
  value = Math.floor(value / 1000)
  const seconds = value % 60
  value = Math.floor(value / 60)
  const minutes = value % 60
  const hours = Math.floor(value / 60)
  const core =
    String(hours).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0') +
    ',' +
    String(millis).padStart(3, '0')
  return negative ? '-' + core : core
}
