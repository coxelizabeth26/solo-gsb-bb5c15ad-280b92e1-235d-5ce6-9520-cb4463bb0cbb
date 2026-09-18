import { useState } from 'react'
import { CUT_STATUS_LABEL, type CutItemError, type CutPlan, type CutStatus } from '../lib/cut'
import { formatTime } from '../lib/time'

interface Props {
  /** 当前有效清单的重排结果；无有效清单（仅有报错）时为 null。 */
  plan: CutPlan | null
  fileName: string
  itemCount: number
  /** 上一次非法导入的逐项错误（不影响当前有效结果）。 */
  errors: CutItemError[] | null
  errorFileName: string
  /** 主轨是否存在校验错误（仅提示，不拦截删减预览与导出）。 */
  mainHasErrors: boolean
  mainErrorCount: number
  onReplace: () => void
  onUnload: () => void
  onExport: () => void
}

const BADGE_CLASS: Record<CutStatus, string> = {
  removed: 'cut-badge-removed',
  split: 'cut-badge-split',
  shifted: 'cut-badge-shifted',
  unchanged: 'cut-badge-unchanged',
}

/**
 * 删减清单重排面板：预览移除、拆分（含截断）与位移结果。
 * plan 由父组件在校准时间轴（锚点）或清单变化时实时重算。
 */
export default function CutPanel({
  plan,
  fileName,
  itemCount,
  errors,
  errorFileName,
  mainHasErrors,
  mainErrorCount,
  onReplace,
  onUnload,
  onExport,
}: Props) {
  const [showAll, setShowAll] = useState(false)

  const affected = plan ? plan.removedCount + plan.splitCount + plan.shiftedCount : 0
  const visible = plan
    ? showAll
      ? plan.entries
      : plan.entries.filter((e) => e.status !== 'unchanged')
    : []

  return (
    <section className="merge-section cut-section">
      <div className="merge-head">
        <div className="merge-title">
          <span className="merge-icon">✂️</span>
          <strong>删减清单重排</strong>
          {plan ? (
            <span className="merge-file mono" title={fileName}>
              清单：{fileName}（{itemCount} 项 → {plan.ranges.length} 个删减区间）
            </span>
          ) : (
            <span className="merge-file">当前无有效清单</span>
          )}
        </div>
        <div className="merge-head-actions">
          <button className="btn btn-small" onClick={onReplace}>
            {plan ? '替换删减清单' : '重新导入清单'}
          </button>
          <button className="btn btn-small btn-ghost" onClick={onUnload}>
            移除清单
          </button>
          <button
            className="btn btn-small btn-primary"
            disabled={!plan}
            onClick={onExport}
            title={plan ? '导出删减重排结果（按结果顺序从 1 重编号）' : '无有效清单，无法导出'}
          >
            导出 .cut.srt
          </button>
        </div>
      </div>

      <p className="merge-rules">
        从校准后的字幕区间中扣除删减段：完全落入删减段的字幕被移除；跨越删减边界的字幕拆成各个非空片段并保留原文本；
        其余片段按此前累计删减时长向前平移。锚点变化后本预览实时重算，不影响锚点与双语合并状态。
      </p>

      {errors && (
        <div className="cut-errors" role="alert">
          <div className="cut-errors-head">
            ✕ 清单「{errorFileName}」被拒绝：{errors.length} 处非法。
            {plan ? '逐项错误如下，当前有效结果保持不变。' : '逐项错误如下，修正后重新导入。'}
          </div>
          <ul className="cut-error-list">
            {errors.map((err, i) => (
              <li key={i}>
                {err.item > 0 ? `第 ${err.item} 项：` : ''}
                {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {mainHasErrors && (
        <div className="export-blocked merge-blocked">
          ⚠ 主轨存在 {mainErrorCount} 条校验错误，删减结果基于当前校准时间计算；建议先清零错误。
        </div>
      )}

      {plan && (
        <>
          <div className="plan-summary cut-summary">
            <span className="pill pill-total">删减区间 {plan.ranges.length} 个</span>
            <span className="pill pill-total mono">总删减 {formatTime(plan.totalCutMs)}</span>
            <span className="pill pill-conflict">移除 {plan.removedCount}</span>
            <span className="pill pill-migrated">拆分 {plan.splitCount}</span>
            <span className="pill pill-direct">位移 {plan.shiftedCount}</span>
            <span className="pill pill-total">不变 {plan.unchangedCount}</span>
            <span className="pill pill-total">输出 {plan.output.length} 条</span>
            <span className="cut-filter">
              <span className="filter-group" role="tablist" aria-label="删减预览筛选">
                <button
                  className={'chip' + (!showAll ? ' active' : '')}
                  onClick={() => setShowAll(false)}
                >
                  仅受影响 {affected}
                </button>
                <button
                  className={'chip' + (showAll ? ' active' : '')}
                  onClick={() => setShowAll(true)}
                >
                  全部 {plan.entries.length}
                </button>
              </span>
            </span>
          </div>

          {plan.ranges.length > 0 && (
            <div className="cut-ranges" title="合并后的删减区间">
              {plan.ranges.map((r, i) => (
                <span key={i} className="cut-range mono">
                  {formatTime(r.start)}
                  <span className="sep">→</span>
                  {formatTime(r.end)}
                </span>
              ))}
            </div>
          )}

          <div className="merge-table-wrap cut-table-wrap">
            <table className="plan-table merge-table cut-table">
              <thead>
                <tr>
                  <th className="pl-no">#</th>
                  <th className="cut-status-col">结果</th>
                  <th className="pl-time">校准后区间</th>
                  <th>输出片段（重编号 · 输出区间 · 位移）</th>
                  <th>字幕文本</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => (
                  <tr
                    key={entry.cueIndex}
                    className={entry.status === 'removed' ? 'cut-row-removed' : ''}
                  >
                    <td className="pl-no">{entry.cueId}</td>
                    <td className="cut-status-col">
                      <span className={'cut-badge ' + BADGE_CLASS[entry.status]}>
                        {CUT_STATUS_LABEL[entry.status]}
                      </span>
                      {entry.status === 'split' && (
                        <div className="cut-sub">{entry.fragments.length} 段</div>
                      )}
                    </td>
                    <td className="pl-time mono">
                      {formatTime(Math.round(entry.start))}
                      <span className="sep">→</span>
                      {formatTime(Math.round(entry.end))}
                    </td>
                    <td className="cut-frags">
                      {entry.fragments.length === 0 ? (
                        <span className="pl-na">—</span>
                      ) : (
                        <ul className="cut-frag-list">
                          {entry.fragments.map((f, i) => (
                            <li key={i} className="mono">
                              <span className="cut-out-no">#{f.outNo}</span>
                              {formatTime(Math.round(f.newStart))}
                              <span className="sep">→</span>
                              {formatTime(Math.round(f.newEnd))}
                              <span className="cut-shift">
                                {f.shift > 0 ? `前移 ${formatTime(Math.round(f.shift))}` : '不位移'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="pl-text">
                      <pre className="cue-text">{entry.text}</pre>
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-row">
                      {showAll ? '没有字幕。' : '没有受删减影响的字幕（全部保持不变）。'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
