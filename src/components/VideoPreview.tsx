import { useMemo, useState } from 'react'
import type { MappedLine } from '../lib/anchor'
import { activeLines } from '../lib/sync'
import { formatTime } from '../lib/time'

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

interface Props {
  /** 视频对象 URL（由父组件负责创建与释放）。 */
  url: string
  name: string
  lines: MappedLine[]
  /** 当前播放位置（毫秒），由父组件持有，保证表格高亮与叠加字幕同源。 */
  currentMs: number
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  onTimeChange: (ms: number) => void
  onReplace: () => void
  onUnload: () => void
  onError: () => void
}

/**
 * 本地视频同步预览：原生播放/暂停/拖动 + 倍速控制，
 * 按校准后的起止时间叠加当前字幕（重叠时按字幕顺序同时展示）。
 */
export default function VideoPreview({
  url,
  name,
  lines,
  currentMs,
  videoRef,
  onTimeChange,
  onReplace,
  onUnload,
  onError,
}: Props) {
  const [durationSec, setDurationSec] = useState(0)
  const [rate, setRate] = useState(1)

  // 播放进度或锚点编辑（lines 变化）都会使该派生结果立即更新
  const active = useMemo(() => activeLines(lines, currentMs), [lines, currentMs])

  const syncTime = () => {
    const video = videoRef.current
    if (video) onTimeChange(Math.round(video.currentTime * 1000))
  }

  const applyRate = (r: number) => {
    const video = videoRef.current
    if (video) {
      video.playbackRate = r
      // 让倍速在替换视频（重新 load）后仍然保持
      video.defaultPlaybackRate = r
    }
    setRate(r)
  }

  const durationMs = Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0

  return (
    <div className="video-preview">
      <div className="video-head">
        <span className="video-name" title={name}>
          🎬 {name}
        </span>
        <span className="video-time mono">
          {formatTime(currentMs)} / {formatTime(durationMs)}
        </span>
        <div className="filter-group" role="group" aria-label="倍速">
          {RATES.map((r) => (
            <button
              key={r}
              className={'chip' + (rate === r ? ' active' : '')}
              onClick={() => applyRate(r)}
            >
              {r}×
            </button>
          ))}
        </div>
        <span className="video-head-spacer" />
        <button className="btn btn-small" onClick={onReplace}>
          替换视频
        </button>
        <button className="btn btn-small btn-ghost" onClick={onUnload}>
          卸载视频
        </button>
      </div>
      <div className="video-stage">
        <video
          ref={videoRef}
          src={url}
          controls
          preload="metadata"
          onTimeUpdate={syncTime}
          onSeeking={syncTime}
          onSeeked={syncTime}
          onLoadedMetadata={(e) => {
            setDurationSec(e.currentTarget.duration)
            setRate(e.currentTarget.playbackRate)
            syncTime()
          }}
          onDurationChange={(e) => setDurationSec(e.currentTarget.duration)}
          onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
          onError={onError}
        />
        {active.length > 0 && (
          <div className="subtitle-overlay">
            {active.map((line) => (
              <div key={line.index} className="subtitle-line">
                {line.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
