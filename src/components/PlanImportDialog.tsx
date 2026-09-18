import { useEffect } from 'react'
import type { Cue } from '../lib/srt'
import { formatTime } from '../lib/time'
import { CONFLICT_LABEL, type PlanPreview } from '../lib/plan'

interface Props {
  preview: PlanPreview
  cues: Cue[]
  fileName: string
  onApply: () => void
  onCancel: () => void
}

/** 锚点方案导入预览：逐项展示匹配结果，冲突项不会被应用。 */
export default function PlanImportDialog({ preview, cues, fileName, onApply, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const cueByIdx = new Map(cues.map((c) => [c.index, c]))

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="plan-preview-title">
        <div className="modal-head">
          <h2 id="plan-preview-title">导入锚点方案 · 匹配预览</h2>
          <button className="btn btn-small btn-ghost" onClick={onCancel} aria-label="关闭预览">
            ✕
          </button>
        </div>
        <p className="modal-sub">
          方案文件：<span className="mono">{fileName}</span>。仅“直接匹配 / 文本迁移”的有效项会被应用，
          冲突项（重复、缺失、破坏顺序）一律不应用；应用后只替换校准锚点，<strong>不会修改任何字幕文本</strong>。
        </p>

        <div className="plan-summary">
          <span className="pill pill-total">共 {preview.entries.length} 个锚点</span>
          <span className="pill pill-direct">
            直接匹配 {preview.entries.filter((e) => e.status === 'direct').length}
          </span>
          <span className="pill pill-migrated">
            文本迁移 {preview.entries.filter((e) => e.status === 'migrated').length}
          </span>
          <span className="pill pill-conflict">冲突 {preview.conflictCount}</span>
        </div>

        <div className="plan-table-wrap">
          <table className="plan-table">
            <thead>
              <tr>
                <th className="pl-status">匹配结果</th>
                <th className="pl-time">方案原始时间</th>
                <th className="pl-time">目标时间</th>
                <th>方案中的规范化文本</th>
                <th className="pl-cue">当前字幕</th>
              </tr>
            </thead>
            <tbody>
              {preview.entries.map((e, i) => {
                const cue = e.cueIndex !== null ? cueByIdx.get(e.cueIndex) : undefined
                return (
                  <tr key={i} className={e.status === 'conflict' ? 'pl-row-conflict' : ''}>
                    <td className="pl-status">
                      {e.status === 'direct' && <span className="match-badge badge-direct">直接匹配</span>}
                      {e.status === 'migrated' && <span className="match-badge badge-migrated">文本迁移</span>}
                      {e.status === 'conflict' && (
                        <span className="match-badge badge-conflict" title={e.conflictReason ?? ''}>
                          冲突
                        </span>
                      )}
                      {e.status === 'conflict' && e.conflictReason && (
                        <div className="conflict-reason">{CONFLICT_LABEL[e.conflictReason]}</div>
                      )}
                    </td>
                    <td className="pl-time mono">{formatTime(e.sourceMs)}</td>
                    <td className="pl-time mono">{formatTime(e.targetMs)}</td>
                    <td className="pl-text" title={e.text}>
                      {e.text}
                    </td>
                    <td className="pl-cue">
                      {cue ? (
                        <span>
                          <span className="pl-cue-id">#{cue.id}</span>
                          <span className="mono pl-cue-time">{formatTime(cue.start)}</span>
                        </span>
                      ) : (
                        <span className="pl-na">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="modal-foot">
          <span className="modal-foot-hint">
            {preview.validCount === 0
              ? '没有可应用的有效锚点。'
              : `将应用 ${preview.validCount} 个有效锚点，作为一次操作进入撤销历史。`}
          </span>
          <div className="modal-foot-actions">
            <button className="btn" onClick={onCancel}>
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={preview.validCount === 0 || !preview.anchors}
              onClick={onApply}
            >
              应用全部有效项（{preview.validCount}）
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
