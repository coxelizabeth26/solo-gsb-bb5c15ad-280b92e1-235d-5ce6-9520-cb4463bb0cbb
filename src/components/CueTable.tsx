import type { Anchor, Issue, MappedLine } from '../lib/anchor'
import { ISSUE_LABEL } from '../lib/anchor'
import { formatTime } from '../lib/time'
import TargetTimeInput from './TargetTimeInput'

export type FilterMode = 'all' | 'anchors' | 'errors'

interface Props {
  lines: MappedLine[]
  anchors: Anchor[]
  issues: Map<number, Issue[]>
  filter: FilterMode
  onAddAnchor: (index: number) => void
  onRemoveAnchor: (source: number) => void
  onEditAnchor: (source: number, targetText: string) => boolean
  /** 当前播放时刻处于有效区间内的字幕 index 集合（未载入视频时为 null）。 */
  activeIndices?: Set<number> | null
  /** 载入视频后提供：点击字幕行跳转到其校准后起始时间。 */
  onSeekTo?: (line: MappedLine) => void
}

function formatDelta(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '±'
  const v = Math.abs(ms)
  return `${sign}${formatTime(v)}`
}

export default function CueTable({
  lines,
  anchors,
  issues,
  filter,
  onAddAnchor,
  onRemoveAnchor,
  onEditAnchor,
  activeIndices,
  onSeekTo,
}: Props) {
  const anchorBySource = new Map(anchors.map((a) => [a.source, a]))

  const visible = lines.filter((line) => {
    if (filter === 'anchors') return anchorBySource.has(line.start)
    if (filter === 'errors') return issues.has(line.index)
    return true
  })

  /** 点击行跳转；行内的按钮 / 输入框等交互元素不触发。 */
  const rowClick = (e: React.MouseEvent, line: MappedLine) => {
    if (!onSeekTo) return
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return
    onSeekTo(line)
  }

  return (
    <div className="table-wrap">
      <table className="cue-table">
        <thead>
          <tr>
            <th className="col-no">#</th>
            <th className="col-time">原始起始 / 结束</th>
            <th className="col-delta">偏移</th>
            <th className="col-time">校准后起始 / 结束</th>
            <th className="col-anchor">校准锚点（目标起始时间）</th>
            <th>字幕文本</th>
            <th className="col-status">状态</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((line) => {
            const anchor = anchorBySource.get(line.start)
            const lineIssues = issues.get(line.index) ?? []
            const hasError = lineIssues.length > 0
            const isActive = activeIndices?.has(line.index) ?? false
            const rowClass = [
              hasError ? 'row-error' : '',
              isActive ? 'row-active' : '',
              onSeekTo ? 'row-clickable' : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <tr
                key={line.index}
                className={rowClass}
                onClick={onSeekTo ? (e) => rowClick(e, line) : undefined}
                title={onSeekTo ? '点击跳转到该校准后起始时间' : undefined}
              >
                <td className="col-no">{line.id}</td>
                <td className="col-time mono">
                  <span className={line.newStart < 0 ? 'bad-time' : ''}>
                    {formatTime(line.start)}
                  </span>
                  <span className="sep">→</span>
                  <span>{formatTime(line.end)}</span>
                </td>
                <td className={'col-delta mono delta-' + deltaClass(line)}>
                  {line.newStart - line.start === 0 &&
                  line.newEnd - line.end === 0
                    ? '—'
                    : formatDelta(line.newStart - line.start)}
                </td>
                <td className="col-time mono">
                  <span className={line.newStart < 0 ? 'bad-time' : ''}>
                    {formatTime(line.newStart)}
                  </span>
                  <span className="sep">→</span>
                  <span className={line.newEnd < 0 ? 'bad-time' : ''}>
                    {formatTime(line.newEnd)}
                  </span>
                </td>
                <td className="col-anchor">
                  {anchor ? (
                    <div className="anchor-edit">
                      <TargetTimeInput
                        value={anchor.target}
                        onSubmit={(text) => onEditAnchor(anchor.source, text)}
                      />
                      <button
                        className="btn btn-small btn-ghost"
                        title="删除该锚点"
                        onClick={() => onRemoveAnchor(anchor.source)}
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn btn-small"
                      onClick={() => onAddAnchor(line.index)}
                    >
                      ＋ 设为锚点
                    </button>
                  )}
                </td>
                <td className="col-text">
                  <pre className="cue-text">{line.text}</pre>
                </td>
                <td className="col-status">
                  {hasError ? (
                    <ul className="issue-list">
                      {lineIssues.map((issue, i) => (
                        <li key={i} className="issue-tag" title={issueText(issue)}>
                          {ISSUE_LABEL[issue.kind]}
                          {issue.kind === 'overlap' && issue.withId
                            ? `（#${issue.withId}）`
                            : ''}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="ok-tag">正常</span>
                  )}
                </td>
              </tr>
            )
          })}
          {visible.length === 0 && (
            <tr>
              <td colSpan={7} className="empty-row">
                当前筛选条件下没有字幕。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function deltaClass(line: MappedLine): string {
  const d = line.newStart - line.start
  if (d > 0) return 'plus'
  if (d < 0) return 'minus'
  return 'zero'
}

function issueText(issue: Issue): string {
  const base = ISSUE_LABEL[issue.kind]
  if (issue.kind === 'overlap' && issue.withId) {
    return `${base}：与第 ${issue.withId} 条字幕重叠`
  }
  return base
}
