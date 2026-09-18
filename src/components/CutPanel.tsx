import type { CutPlan, CutLineResult } from '../lib/cut'
import { formatTime } from '../lib/time'

interface Props {
  plan: CutPlan
  /** 清单原始条目数（合并前）。 */
  rawCount: number
  cutFileName: string
  /** 主轨是否存在校验错误；存在时禁止删减导出。 */
  hasErrors: boolean
  errorCount: number
  onReplaceCut: () => void
  onUnloadCut: () => void
  onExportCut: () => void
}

const STATUS_LABEL: Record<CutLineResult['status'], string> = {
  removed: '移除',
  split: '拆分',
  shifted: '前移',
  kept: '不变',
}

/**
 * 删减清单重排面板：锚点变化后由父组件实时重算 plan，
 * 预览移除、拆分与前移结果，并提供独立的 .cut.srt 导出。
 */
export default function CutPanel({
  plan,
  rawCount,
  cutFileName,
  hasErrors,
  errorCount,
  onReplaceCut,
  onUnloadCut,
  onExportCut,
}: Props) {
  const removed = plan.results.filter((r) => r.status === 'removed')
  const split = plan.results.filter((r) => r.status === 'split')
  const shifted = plan.results.filter((r) => r.status === 'shifted')

  return (
    <section className="merge-section cut-section">
      <div className="merge-head">
        <div className="merge-title">
          <span className="merge-icon">✂️</span>
          <strong>删减清单重排</strong>
          <span className="merge-file mono" title={cutFileName}>
            清单：{cutFileName}（{rawCount} 段 → 合并为 {plan.ranges.length} 段）
          </span>
        </div>
        <div className="merge-head-actions">
          <button className="btn btn-small" onClick={onReplaceCut}>
            替换删减清单
          </button>
          <button className="btn btn-small btn-ghost" onClick={onUnloadCut}>
            移除清单
          </button>
          <button
            className="btn btn-small btn-primary"
            disabled={hasErrors || plan.fragmentCount === 0}
            onClick={onExportCut}
            title={
              hasErrors
                ? `主轨仍有 ${errorCount} 条校验错误，解决后才能导出删减 SRT`
                : plan.fragmentCount === 0
                  ? '所有字幕均落入删减段，没有可导出的片段'
                  : undefined
            }
          >
            导出 .cut.srt
          </button>
        </div>
      </div>

      <p className="merge-rules">
        先按时间排序并合并相交或相接的删减段，再从校准后的每条字幕区间中扣除：
        完全落入删减段的字幕移除，跨越删减边界的字幕拆成各个非空片段并保留原文本，
        其余片段按此前累计删减时长向前平移。锚点变化后本预览实时重算，锚点与双语合并状态不受影响。
      </p>

      <div className="plan-summary">
        <span className="pill pill-total">输入清单 {rawCount} 段</span>
        <span className="pill pill-total">合并后 {plan.ranges.length} 段</span>
        <span className="pill pill-conflict">移除 {plan.removed}</span>
        <span className="pill pill-direct">拆分 {plan.split}</span>
        <span className="pill pill-shift">前移 {plan.shifted}</span>
        <span className="pill pill-total">不变 {plan.kept}</span>
        <span className="pill pill-migrated">导出片段 {plan.fragmentCount}</span>
      </div>

      <div className="cut-ranges">
        <h3 className="merge-col-title">
          合并后的删减段（{plan.ranges.length}）
          <span className="merge-col-hint">校准后时间轴</span>
        </h3>
        <div className="cut-range-list">
          {plan.ranges.map((r, i) => (
            <span key={i} className="cut-range-pill mono">
              {formatTime(Math.round(r.start))} → {formatTime(Math.round(r.end))}
              <span className="cut-range-dur">（{formatTime(Math.round(r.end - r.start))}）</span>
            </span>
          ))}
        </div>
      </div>

      {hasErrors && (
        <div className="export-blocked merge-blocked">
          ⚠ 主轨存在 {errorCount} 条校验错误（负时间 / 重叠 / 非正时长），错误未解决前禁止删减导出。
          删减预览仍会实时更新，解决错误后即可导出。
        </div>
      )}

      {removed.length > 0 && (
        <CutGroup title={`移除（${removed.length}）`} cls="cut-group-removed">
          <table className="plan-table cut-table">
            <thead>
              <tr>
                <th className="pl-no">原序号</th>
                <th className="pl-time">校准后时间</th>
                <th>字幕文本</th>
                <th className="pl-status">处置</th>
              </tr>
            </thead>
            <tbody>
              {removed.map((r) => (
                <tr key={r.index}>
                  <td className="pl-no">{r.id}</td>
                  <td className="pl-time mono">
                    {formatTime(Math.round(r.oldStart))}
                    <span className="sep">→</span>
                    {formatTime(Math.round(r.oldEnd))}
                  </td>
                  <td className="pl-text cut-text">
                    <pre className="cue-text">{r.text}</pre>
                  </td>
                  <td className="pl-status">
                    <span className="match-badge badge-conflict">{STATUS_LABEL.removed}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CutGroup>
      )}

      {split.length > 0 && (
        <CutGroup title={`拆分（${split.length}）`} cls="cut-group-split">
          <table className="plan-table cut-table">
            <thead>
              <tr>
                <th className="pl-no">原序号</th>
                <th className="pl-time">校准后时间</th>
                <th>片段（输出时间码 / 前移量）</th>
                <th>保留文本</th>
              </tr>
            </thead>
            <tbody>
              {split.map((r) => (
                <tr key={r.index}>
                  <td className="pl-no">{r.id}</td>
                  <td className="pl-time mono">
                    {formatTime(Math.round(r.oldStart))}
                    <span className="sep">→</span>
                    {formatTime(Math.round(r.oldEnd))}
                  </td>
                  <td className="cut-frags">
                    <ol className="cut-frag-list mono">
                      {r.fragments.map((f, i) => (
                        <li key={i}>
                          {formatTime(Math.round(f.outStart))}
                          <span className="sep">→</span>
                          {formatTime(Math.round(f.outEnd))}
                          <span className="cut-shift">前移 {formatTime(Math.round(f.shift))}</span>
                        </li>
                      ))}
                    </ol>
                  </td>
                  <td className="pl-text cut-text">
                    <pre className="cue-text">{r.text}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CutGroup>
      )}

      {shifted.length > 0 && (
        <CutGroup title={`前移（${shifted.length}）`} cls="cut-group-shifted">
          <table className="plan-table cut-table">
            <thead>
              <tr>
                <th className="pl-no">原序号</th>
                <th className="pl-time">校准后时间</th>
                <th className="pl-time">输出时间</th>
                <th className="pl-score">前移量</th>
                <th>字幕文本</th>
              </tr>
            </thead>
            <tbody>
              {shifted.map((r) => {
                const f = r.fragments[0]
                return (
                  <tr key={r.index}>
                    <td className="pl-no">{r.id}</td>
                    <td className="pl-time mono">
                      {formatTime(Math.round(r.oldStart))}
                      <span className="sep">→</span>
                      {formatTime(Math.round(r.oldEnd))}
                    </td>
                    <td className="pl-time mono">
                      {formatTime(Math.round(f.outStart))}
                      <span className="sep">→</span>
                      {formatTime(Math.round(f.outEnd))}
                    </td>
                    <td className="pl-score mono cut-shift-cell">
                      −{formatTime(Math.round(f.shift))}
                    </td>
                    <td className="pl-text cut-text">
                      <pre className="cue-text">{r.text}</pre>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </CutGroup>
      )}
    </section>
  )
}

function CutGroup({
  title,
  cls,
  children,
}: {
  title: string
  cls: string
  children: React.ReactNode
}) {
  return (
    <div className={'cut-group ' + cls}>
      <h3 className="merge-col-title cut-group-title">{title}</h3>
      <div className="merge-table-wrap cut-table-wrap">{children}</div>
    </div>
  )
}
