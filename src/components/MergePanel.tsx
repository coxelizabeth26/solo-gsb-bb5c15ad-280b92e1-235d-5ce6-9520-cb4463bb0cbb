import type { MappedLine } from '../lib/anchor'
import type { Cue } from '../lib/srt'
import type { MergePlan } from '../lib/merge'
import { formatTime } from '../lib/time'

interface Props {
  /** 主轨（校准后）字幕。 */
  lines: MappedLine[]
  /** 次轨原始字幕。 */
  secCues: Cue[]
  secFileName: string
  plan: MergePlan
  /** 主轨是否存在校验错误；存在时禁止合并导出。 */
  hasErrors: boolean
  errorCount: number
  onReplaceSec: () => void
  onUnloadSec: () => void
  onExportMerged: () => void
}

/**
 * 双语字幕合并面板：锚点变化后由父组件实时重算 plan，
 * 展示一对一匹配结果以及双方未匹配条目。
 */
export default function MergePanel({
  lines,
  secCues,
  secFileName,
  plan,
  hasErrors,
  errorCount,
  onReplaceSec,
  onUnloadSec,
  onExportMerged,
}: Props) {
  const mainByIdx = new Map(lines.map((l) => [l.index, l]))
  const secByIdx = new Map(secCues.map((c) => [c.index, c]))

  return (
    <section className="merge-section">
      <div className="merge-head">
        <div className="merge-title">
          <span className="merge-icon">🈂️</span>
          <strong>双语字幕合并</strong>
          <span className="merge-file mono" title={secFileName}>
            次轨：{secFileName}（{secCues.length} 条）
          </span>
        </div>
        <div className="merge-head-actions">
          <button className="btn btn-small" onClick={onReplaceSec}>
            替换次轨 SRT
          </button>
          <button className="btn btn-small btn-ghost" onClick={onUnloadSec}>
            移除次轨
          </button>
          <button
            className="btn btn-small btn-primary"
            disabled={hasErrors}
            onClick={onExportMerged}
            title={hasErrors ? `主轨仍有 ${errorCount} 条校验错误，解决后才能合并导出` : undefined}
          >
            导出双语 SRT
          </button>
        </div>
      </div>

      <p className="merge-rules">
        仅匹配“正重叠且重叠不少于较短字幕 50%”的候选；全部合法匹配中优先最大化总重叠时长，
        再最小化起始时间差总和，仍并列时选择次轨序号字典序更早的方案。锚点变化后本预览实时重算。
      </p>

      <div className="plan-summary">
        <span className="pill pill-total">主轨 {lines.length} 条</span>
        <span className="pill pill-total">次轨 {secCues.length} 条</span>
        <span className="pill pill-direct">已匹配 {plan.edges.length} 对</span>
        <span className="pill pill-migrated">主轨未匹配 {plan.unmatchedMain.length}</span>
        <span className="pill pill-conflict">次轨未匹配 {plan.unmatchedSecondary.length}</span>
        <span className="pill pill-total mono">总重叠 {formatTime(Math.round(plan.totalOverlap))}</span>
        <span className="pill pill-total mono">起始时差合计 {formatTime(Math.round(plan.totalStartDelta))}</span>
      </div>

      {hasErrors && (
        <div className="export-blocked merge-blocked">
          ⚠ 主轨存在 {errorCount} 条校验错误（负时间 / 重叠 / 非正时长），错误未解决前禁止合并导出。
          匹配预览仍会实时更新，解决错误后即可导出。
        </div>
      )}

      <div className="merge-table-wrap">
        <table className="plan-table merge-table">
          <thead>
            <tr>
              <th className="pl-no">#</th>
              <th className="pl-time">主轨校准后时间</th>
              <th>主轨文本（导出行 1）</th>
              <th className="pl-cue">次轨序号</th>
              <th className="pl-time">次轨时间</th>
              <th>次轨文本（追加行 2）</th>
              <th className="pl-score">重叠 / 起始差</th>
            </tr>
          </thead>
          <tbody>
            {plan.edges.map((edge) => {
              const main = mainByIdx.get(edge.mainIndex)
              const sec = secByIdx.get(edge.secIndex)
              if (!main || !sec) return null
              return (
                <tr key={edge.mainIndex}>
                  <td className="pl-no">{main.id}</td>
                  <td className="pl-time mono">
                    {formatTime(Math.round(main.newStart))}
                    <span className="sep">→</span>
                    {formatTime(Math.round(main.newEnd))}
                  </td>
                  <td className="pl-text">
                    <pre className="cue-text">{main.text}</pre>
                  </td>
                  <td className="pl-cue">
                    <span className="pl-cue-id">#{sec.id}</span>
                  </td>
                  <td className="pl-time mono">
                    {formatTime(sec.start)}
                    <span className="sep">→</span>
                    {formatTime(sec.end)}
                  </td>
                  <td className="pl-text">
                    <pre className="cue-text">{sec.text}</pre>
                  </td>
                  <td className="pl-score mono">
                    {formatTime(Math.round(edge.overlap))}
                    <span className="merge-delta">Δ{formatTime(Math.round(edge.startDelta))}</span>
                  </td>
                </tr>
              )
            })}
            {plan.edges.length === 0 && (
              <tr>
                <td colSpan={7} className="empty-row">
                  没有满足条件的匹配对（需要正重叠且重叠不少于较短字幕的 50%）。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="merge-unmatched">
        <div className="merge-col">
          <h3 className="merge-col-title">
            主轨未匹配（{plan.unmatchedMain.length}）
            <span className="merge-col-hint">照常导出，仅含主轨文本</span>
          </h3>
          <ul className="merge-list">
            {plan.unmatchedMain.map((mi) => {
              const main = mainByIdx.get(mi)
              if (!main) return null
              return (
                <li key={mi}>
                  <span className="pl-cue-id">#{main.id}</span>
                  <span className="mono merge-list-time">
                    {formatTime(Math.round(main.newStart))}
                  </span>
                  <span className="merge-list-text" title={main.text}>
                    {main.text}
                  </span>
                </li>
              )
            })}
            {plan.unmatchedMain.length === 0 && <li className="merge-list-empty">无</li>}
          </ul>
        </div>
        <div className="merge-col">
          <h3 className="merge-col-title">
            次轨未匹配（{plan.unmatchedSecondary.length}）
            <span className="merge-col-hint merge-hint-warn">仅提示，不写入导出文件</span>
          </h3>
          <ul className="merge-list">
            {plan.unmatchedSecondary.map((si) => {
              const sec = secByIdx.get(si)
              if (!sec) return null
              return (
                <li key={si}>
                  <span className="pl-cue-id">#{sec.id}</span>
                  <span className="mono merge-list-time">{formatTime(sec.start)}</span>
                  <span className="merge-list-text" title={sec.text}>
                    {sec.text}
                  </span>
                </li>
              )
            })}
            {plan.unmatchedSecondary.length === 0 && <li className="merge-list-empty">无</li>}
          </ul>
        </div>
      </div>
    </section>
  )
}
