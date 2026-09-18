import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CueTable, { type FilterMode } from './components/CueTable'
import MergePanel from './components/MergePanel'
import PlanImportDialog from './components/PlanImportDialog'
import VideoPreview from './components/VideoPreview'
import { buildSrt, type Cue, parseSrt } from './lib/srt'
import {
  buildAnchors,
  mapCues,
  validateMapped,
  type Anchor,
  type MappedLine,
} from './lib/anchor'
import { activeLines, seekTargetSec } from './lib/sync'
import { formatTime, parseTime } from './lib/time'
import { parsePlan, previewPlan, serializePlan, type PlanPreview } from './lib/plan'
import { buildMergedSrt, computeMergePlan, type MergePlan } from './lib/merge'
import { SAMPLE_SRT } from './sample'

interface Notice {
  level: 'info' | 'error'
  text: string
}

export default function App() {
  const [cues, setCues] = useState<Cue[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [anchors, setAnchors] = useState<Anchor[]>([])
  const [history, setHistory] = useState<Anchor[][]>([])
  const [filter, setFilter] = useState<FilterMode>('all')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dragging, setDragging] = useState(false)
  const [planPreview, setPlanPreview] = useState<PlanPreview | null>(null)
  const [planFileName, setPlanFileName] = useState('')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoName, setVideoName] = useState('')
  const [playMs, setPlayMs] = useState(0)
  const [secCues, setSecCues] = useState<Cue[] | null>(null)
  const [secFileName, setSecFileName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const planFileRef = useRef<HTMLInputElement>(null)
  const videoFileRef = useRef<HTMLInputElement>(null)
  const secFileRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  /** 当前持有的视频对象 URL，用于在替换 / 卸载 / 组件卸载时精确释放。 */
  const videoUrlRef = useRef<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)

  const lines = useMemo(() => (cues ? mapCues(cues, anchors) : []), [cues, anchors])
  const issues = useMemo(() => validateMapped(lines), [lines])
  /** 当前播放时刻处于有效区间内的字幕；锚点编辑改变 lines 时会立即重算。 */
  const activeIndices = useMemo(
    () => (videoUrl ? new Set(activeLines(lines, playMs).map((l) => l.index)) : null),
    [lines, playMs, videoUrl],
  )
  const errorCount = useMemo(() => {
    const set = new Set<number>()
    for (const index of issues.keys()) set.add(index)
    return set.size
  }, [issues])
  const hasErrors = errorCount > 0

  /**
   * 双语合并匹配：锚点（lines）或次轨任一变化都立即重算；
   * 规模过大等异常情况下返回错误信息，不再给出预览。
   */
  const mergeResult: { plan: MergePlan | null; error: string | null } = useMemo(() => {
    if (!secCues) return { plan: null, error: null }
    try {
      return { plan: computeMergePlan(lines, secCues), error: null }
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : '匹配计算失败。' }
    }
  }, [lines, secCues])
  const mergePlan = mergeResult.plan
  const mergeError = mergeResult.error

  const flash = useCallback((n: Notice) => {
    setNotice(n)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500)
  }, [])

  /** 释放当前持有的视频对象 URL（若有）。 */
  const revokeVideoUrl = useCallback(() => {
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current)
      videoUrlRef.current = null
    }
  }, [])

  // 组件卸载时释放仍持有的对象 URL
  useEffect(() => revokeVideoUrl, [revokeVideoUrl])

  /** 载入本地视频：仅通过对象 URL 在本地使用；替换前先释放旧 URL。 */
  const loadVideo = useCallback(
    (file: File) => {
      revokeVideoUrl()
      const url = URL.createObjectURL(file)
      videoUrlRef.current = url
      setVideoUrl(url)
      setVideoName(file.name)
      setPlayMs(0)
      flash({ level: 'info', text: `已载入视频「${file.name}」，仅通过对象 URL 在本地播放，不会上传。` })
    },
    [flash, revokeVideoUrl],
  )

  /** 卸载视频并释放其对象 URL。 */
  const unloadVideo = useCallback(() => {
    revokeVideoUrl()
    setVideoUrl(null)
    setVideoName('')
    setPlayMs(0)
    flash({ level: 'info', text: '已卸载视频并释放其对象 URL。' })
  }, [flash, revokeVideoUrl])

  const onVideoError = useCallback(() => {
    revokeVideoUrl()
    setVideoUrl(null)
    setVideoName('')
    setPlayMs(0)
    flash({
      level: 'error',
      text: '无法播放该视频：浏览器不支持此格式或文件已损坏，已卸载。请换用浏览器可播放的格式（如 MP4/H.264、WebM）。',
    })
  }, [flash, revokeVideoUrl])

  /** 点击字幕行：跳到其校准后起始时间，超出视频时长则停在末尾。 */
  const seekToLine = useCallback((line: MappedLine) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = seekTargetSec(line.newStart, video.duration)
    // 立即同步高亮，不等 timeupdate 事件
    setPlayMs(Math.round(video.currentTime * 1000))
  }, [])

  /** 在修改锚点之前压栈，用于“撤销最近一次锚点操作”。 */
  const commit = useCallback(
    (next: Anchor[]) => {
      setHistory((h) => [...h, anchors])
      setAnchors(next)
    },
    [anchors],
  )

  const loadSrt = useCallback(
    (content: string, name: string) => {
      const { cues: parsed, skipped } = parseSrt(content)
      if (parsed.length === 0) {
        flash({ level: 'error', text: '未能从文件中解析出任何有效的 SRT 字幕。' })
        return
      }
      setCues(parsed)
      setFileName(name)
      setAnchors([])
      setHistory([])
      setFilter('all')
      setPlanPreview(null)
      setPlanFileName('')
      // 主轨已整体替换，次轨不再适用
      setSecCues(null)
      setSecFileName('')
      // 保留已载入的视频，但重置播放位置
      const video = videoRef.current
      if (video) {
        video.pause()
        video.currentTime = 0
      }
      setPlayMs(0)
      flash({
        level: 'info',
        text:
          `已导入 ${parsed.length} 条字幕。` +
          (skipped > 0 ? `（${skipped} 个无法解析的块已跳过）` : ''),
      })
    },
    [flash],
  )

  const onFile = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = () => loadSrt(String(reader.result ?? ''), file.name)
      reader.onerror = () => flash({ level: 'error', text: '读取文件失败。' })
      reader.readAsText(file)
    },
    [flash, loadSrt],
  )

  /** 为新锚点挑选合法的默认目标时间：尽量保持线性比例并取前后目标的中点。 */
  const defaultTarget = useCallback(
    (source: number, list: Anchor[]): number | null => {
      if (list.length === 0) return Math.max(0, source)
      const before = list.filter((a) => a.source < source)
      const after = list.filter((a) => a.source > source)
      const lo = before[before.length - 1]
      const hi = after[0]

      if (lo && hi) {
        // 至少留 1ms 空隙，保证严格递增
        if (hi.target - lo.target < 2) return null
        const ratio = (source - lo.source) / (hi.source - lo.source)
        return Math.round(lo.target + ratio * (hi.target - lo.source))
      }
      if (lo && !hi) return lo.target + Math.max(1, source - lo.source)
      if (!lo && hi) return Math.max(0, hi.target - Math.max(1, hi.source - source))
      return source
    },
    [],
  )

  const addAnchor = useCallback(
    (cueIndex: number) => {
      if (!cues) return
      const cue = cues.find((c) => c.index === cueIndex)
      if (!cue) return
      if (anchors.some((a) => a.source === cue.start)) {
        flash({ level: 'error', text: '该字幕起始时间已存在锚点（同一原始时间不可重复设置）。' })
        return
      }
      const target = defaultTarget(cue.start, anchors)
      if (target === null) {
        flash({
          level: 'error',
          text: '相邻锚点的目标时间之间已无空隙，无法插入新锚点。请先调整现有目标时间。',
        })
        return
      }
      const next = buildAnchors([
        ...anchors.map((a): [number, number] => [a.source, a.target]),
        [cue.start, target],
      ])
      if (!next) {
        flash({ level: 'error', text: '新增锚点无法满足原始时间与目标时间严格递增。' })
        return
      }
      commit(next)
      flash({ level: 'info', text: `已在第 ${cue.id} 条字幕上添加锚点，可直接编辑其目标时间。` })
    },
    [cues, anchors, commit, defaultTarget, flash],
  )

  const removeAnchor = useCallback(
    (source: number) => {
      const next = anchors.filter((a) => a.source !== source)
      if (next.length === anchors.length) return
      commit(next)
      flash({ level: 'info', text: '锚点已删除，可使用撤销恢复。' })
    },
    [anchors, commit, flash],
  )

  const editAnchor = useCallback(
    (source: number, targetText: string): boolean => {
      const target = parseTime(targetText)
      if (target === null || target < 0) {
        flash({ level: 'error', text: '目标时间格式非法，应为 HH:MM:SS,mmm 且不可为负，编辑未生效。' })
        return false
      }
      const next = buildAnchors(
        anchors.map((a): [number, number] => [a.source, a.source === source ? target : a.target]),
      )
      if (!next) {
        flash({ level: 'error', text: '锚点的目标时间必须严格递增，非法编辑未生效。' })
        return false
      }
      commit(next)
      return true
    },
    [anchors, commit, flash],
  )

  const undo = useCallback(() => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setAnchors(prev)
    setHistory((h) => h.slice(0, -1))
    flash({ level: 'info', text: '已撤销最近一次锚点操作。' })
  }, [history, flash])

  const exportSrt = useCallback(() => {
    if (!cues) return
    if (hasErrors) {
      flash({ level: 'error', text: `仍有 ${errorCount} 条字幕存在错误，解决后才能导出。` })
      return
    }
    const payload = buildSrt(lines)
    const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const base = fileName.replace(/\.srt$/i, '') || 'subtitles'
    a.href = url
    a.download = `${base}.aligned.srt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    flash({ level: 'info', text: '已导出校准后的 SRT 文件（序号与文本保持不变）。' })
  }, [cues, lines, fileName, hasErrors, errorCount, flash])

  /** 导入第二份 SRT（次轨），用于双语合并；匹配预览随锚点实时重算。 */
  const loadSecSrt = useCallback(
    (content: string, name: string) => {
      const { cues: parsed, skipped } = parseSrt(content)
      if (parsed.length === 0) {
        flash({ level: 'error', text: '未能从次轨文件中解析出任何有效的 SRT 字幕。' })
        return
      }
      setSecCues(parsed)
      setSecFileName(name)
      flash({
        level: 'info',
        text:
          `已导入次轨「${name}」共 ${parsed.length} 条字幕，正在按校准后的主时间轴匹配。` +
          (skipped > 0 ? `（${skipped} 个无法解析的块已跳过）` : ''),
      })
    },
    [flash],
  )

  const onSecFile = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = () => loadSecSrt(String(reader.result ?? ''), file.name)
      reader.onerror = () => flash({ level: 'error', text: '读取次轨文件失败。' })
      reader.readAsText(file)
    },
    [flash, loadSecSrt],
  )

  const unloadSec = useCallback(() => {
    setSecCues(null)
    setSecFileName('')
    flash({ level: 'info', text: '已移除次轨，恢复仅主轨视图。' })
  }, [flash])

  /**
   * 导出双语 SRT：主轨时间码与主文本 + 已匹配次轨文本（追加为下一行）。
   * 主轨存在任意校验错误时禁止合并导出。
   */
  const exportMergedSrt = useCallback(() => {
    if (!cues || !secCues || !mergePlan) return
    if (hasErrors) {
      flash({ level: 'error', text: `主轨仍有 ${errorCount} 条字幕存在错误，解决后才能合并导出。` })
      return
    }
    const payload = buildMergedSrt(lines, secCues, mergePlan)
    const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const base = fileName.replace(/\.srt$/i, '') || 'subtitles'
    a.href = url
    a.download = `${base}.bilingual.srt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    flash({
      level: 'info',
      text:
        `已导出双语 SRT：${mergePlan.edges.length} 条合并了次轨文本，` +
        `${mergePlan.unmatchedMain.length} 条未匹配主轨照常导出，` +
        `次轨 ${mergePlan.unmatchedSecondary.length} 条未匹配项未写入。`,
    })
  }, [cues, secCues, mergePlan, lines, fileName, hasErrors, errorCount, flash])

  const downloadFile = useCallback((content: string, downloadName: string, mime: string) => {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = downloadName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [])

  const exportPlan = useCallback(() => {
    if (!cues || anchors.length === 0) return
    const payload = serializePlan(cues, anchors)
    if (payload === null) {
      flash({ level: 'error', text: '导出方案失败：存在无法对应到当前字幕的锚点。' })
      return
    }
    const base = fileName.replace(/\.srt$/i, '') || 'subtitles'
    downloadFile(payload, `${base}.anchor-plan.json`, 'application/json;charset=utf-8')
    flash({
      level: 'info',
      text: `已导出锚点方案（${anchors.length} 个锚点，含原始/目标时间与规范化文本）。`,
    })
  }, [cues, anchors, fileName, downloadFile, flash])

  const openPlanFile = useCallback(
    (file: File) => {
      if (!cues) {
        flash({ level: 'error', text: '请先导入（修订版）SRT 字幕，再导入锚点方案。' })
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const result = parsePlan(String(reader.result ?? ''))
        if ('error' in result) {
          flash({ level: 'error', text: `方案文件被拒绝：${result.error.message}` })
          return
        }
        const preview = previewPlan(result.plan, cues)
        setPlanPreview(preview)
        setPlanFileName(file.name)
        flash({
          level: 'info',
          text:
            `方案预览：${preview.validCount} 个锚点可应用（直接匹配 ${preview.entries.filter((e) => e.status === 'direct').length}、` +
            `文本迁移 ${preview.entries.filter((e) => e.status === 'migrated').length}），` +
            `${preview.conflictCount} 个冲突项不会应用。请在弹窗中确认。`,
        })
      }
      reader.onerror = () => flash({ level: 'error', text: '读取方案文件失败。' })
      reader.readAsText(file)
    },
    [cues, flash],
  )

  const applyPlan = useCallback(() => {
    if (!planPreview || !planPreview.anchors) return
    const next = buildAnchors(planPreview.anchors.map((a): [number, number] => [a.source, a.target]))
    if (!next) {
      flash({ level: 'error', text: '应用失败：有效锚点无法满足原始时间与目标时间严格递增。' })
      setPlanPreview(null)
      return
    }
    setHistory((h) => [...h, anchors])
    setAnchors(next)
    flash({
      level: 'info',
      text:
        `已应用 ${planPreview.validCount} 个锚点（${planPreview.conflictCount} 个冲突项已忽略），` +
        '字幕文本未被修改，可使用撤销恢复。',
    })
    setPlanPreview(null)
    setPlanFileName('')
  }, [planPreview, anchors, flash])

  const cancelPlan = useCallback(() => {
    setPlanPreview(null)
    setPlanFileName('')
    flash({ level: 'info', text: '已取消方案导入，当前锚点未做任何改动。' })
  }, [flash])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (!file) return
      if (/\.json$/i.test(file.name)) {
        openPlanFile(file)
      } else {
        onFile(file)
      }
    },
    [onFile, openPlanFile],
  )

  return (
    <div
      className={'app' + (dragging ? ' drag-over' : '')}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="app-header">
        <h1>SRT 字幕时间轴校准工具</h1>
        <p className="subtitle">本地运行 · 分段线性锚点校准 · 本地视频同步预览 · 校验通过后导出</p>
      </header>

      <section className="toolbar">
        <div className="toolbar-group">
          <input
            ref={fileRef}
            type="file"
            accept=".srt,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onFile(f)
              e.target.value = ''
            }}
          />
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
            导入 SRT
          </button>
          <button
            className="btn"
            disabled={!cues}
            onClick={() => cues && loadSrt(SAMPLE_SRT, '示例字幕.srt')}
            title={cues ? '使用示例字幕替换当前内容' : undefined}
          >
            载入示例
          </button>
          <button className="btn" disabled={history.length === 0} onClick={undo}>
            ↶ 撤销锚点操作{history.length > 0 ? `（${history.length}）` : ''}
          </button>
          <input
            ref={planFileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) openPlanFile(f)
              e.target.value = ''
            }}
          />
          <button
            className="btn"
            disabled={!cues || anchors.length === 0}
            onClick={exportPlan}
            title={
              !cues
                ? '请先导入 SRT 并设置锚点'
                : anchors.length === 0
                  ? '当前没有可导出的锚点'
                  : '把当前锚点（原始/目标时间 + 规范化文本）导出为 JSON 方案'
            }
          >
            导出锚点方案
          </button>
          <button
            className="btn"
            disabled={!cues}
            onClick={() => planFileRef.current?.click()}
            title={cues ? '在当前（修订版）字幕上复用 JSON 锚点方案' : '请先导入 SRT'}
          >
            导入锚点方案
          </button>
          <input
            ref={secFileRef}
            type="file"
            accept=".srt,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onSecFile(f)
              e.target.value = ''
            }}
          />
          <button
            className="btn"
            disabled={!cues}
            onClick={() => secFileRef.current?.click()}
            title={
              cues
                ? '在主轨校准完成后导入第二份 SRT，按校准后时间轴做一对一匹配并导出双语字幕'
                : '请先导入并校准主 SRT'
            }
          >
            {secCues ? '替换次轨 SRT' : '导入次轨 SRT（双语合并）'}
          </button>
          <button className="btn btn-danger-outline" disabled={!cues || hasErrors} onClick={exportSrt}>
            导出新 SRT
          </button>
        </div>
        {cues && (
          <div className="toolbar-group meta">
            <span>文件：{fileName || '未命名'}</span>
            <span>{cues.length} 条字幕</span>
            <span className={anchors.length > 0 ? 'anchor-count' : ''}>
              {anchors.length} 个锚点
            </span>
            <span className={hasErrors ? 'error-count' : 'ok-text'}>
              {hasErrors ? `${errorCount} 条错误` : '校验通过'}
            </span>
            <div className="filter-group" role="tablist" aria-label="筛选">
              {(['all', 'anchors', 'errors'] as FilterMode[]).map((mode) => (
                <button
                  key={mode}
                  className={'chip' + (filter === mode ? ' active' : '')}
                  onClick={() => setFilter(mode)}
                >
                  {mode === 'all' ? '全部' : mode === 'anchors' ? '仅锚点' : `仅错误${hasErrors ? ` ${errorCount}` : ''}`}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {notice && (
        <div className={'notice notice-' + notice.level} role="status">
          {notice.text}
        </div>
      )}

      {!cues ? (
        <EmptyState
          onImport={() => fileRef.current?.click()}
          onSample={() => loadSrt(SAMPLE_SRT, '示例字幕.srt')}
        />
      ) : (
        <>
          <Rules anchors={anchors} />
          <section className="preview-section">
            <input
              ref={videoFileRef}
              type="file"
              accept="video/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) loadVideo(f)
                e.target.value = ''
              }}
            />
            {videoUrl ? (
              <VideoPreview
                url={videoUrl}
                name={videoName}
                lines={lines}
                currentMs={playMs}
                videoRef={videoRef}
                onTimeChange={setPlayMs}
                onReplace={() => videoFileRef.current?.click()}
                onUnload={unloadVideo}
                onError={onVideoError}
              />
            ) : (
              <div className="preview-empty">
                <span>
                  🎬 可选择一个浏览器可播放的本地视频做同步预览：文件仅通过对象 URL
                  在本地使用，不会上传。
                </span>
                <button className="btn" onClick={() => videoFileRef.current?.click()}>
                  选择视频文件
                </button>
              </div>
            )}
          </section>
          {secCues &&
            (mergePlan ? (
              <MergePanel
                lines={lines}
                secCues={secCues}
                secFileName={secFileName}
                plan={mergePlan}
                hasErrors={hasErrors}
                errorCount={errorCount}
                onReplaceSec={() => secFileRef.current?.click()}
                onUnloadSec={unloadSec}
                onExportMerged={exportMergedSrt}
              />
            ) : (
              <div className="export-blocked merge-error">
                {mergeError ?? '匹配计算失败。'}
                <button className="btn btn-small" onClick={unloadSec}>
                  移除次轨
                </button>
              </div>
            ))}
          <CueTable
            lines={lines}
            anchors={anchors}
            issues={issues}
            filter={filter}
            onAddAnchor={addAnchor}
            onRemoveAnchor={removeAnchor}
            onEditAnchor={editAnchor}
            activeIndices={activeIndices}
            onSeekTo={videoUrl ? seekToLine : undefined}
          />
          {hasErrors && (
            <div className="export-blocked">
              ⚠ 存在 {errorCount} 条问题字幕（负时间 / 重叠 / 非正时长），错误未解决前禁止导出。
            </div>
          )}
        </>
      )}

      {planPreview && cues && (
        <PlanImportDialog
          preview={planPreview}
          cues={cues}
          fileName={planFileName}
          onApply={applyPlan}
          onCancel={cancelPlan}
        />
      )}

      {dragging && <div className="drop-mask">松开以导入文件（.srt 字幕 / .json 锚点方案）</div>}
    </div>
  )
}

function EmptyState({ onImport, onSample }: { onImport: () => void; onSample: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-card">
        <div className="empty-icon">🎞️</div>
        <h2>还没有导入字幕</h2>
        <p>将 <code>.srt</code> 文件拖入本页面，或点击下方按钮。所有处理均在浏览器本地完成。</p>
        <div className="empty-actions">
          <button className="btn btn-primary" onClick={onImport}>
            选择 SRT 文件
          </button>
          <button className="btn" onClick={onSample}>
            先试试示例字幕
          </button>
        </div>
        <ul className="rules">
          <li>无锚点：保留全部原始时间。</li>
          <li>单锚点：按其偏移整体平移。</li>
          <li>多锚点：相邻锚点分段线性映射，首尾按最近区段斜率外推。</li>
          <li>锚点的原始时间与目标时间都必须严格递增，非法编辑不会生效。</li>
          <li>负时间、重叠、非正时长会标红，错误清零后才能导出。</li>
        </ul>
      </div>
    </div>
  )
}

function signedOffset(ms: number): string {
  if (ms === 0) return '0'
  return (ms > 0 ? '+' : '-') + formatTime(Math.abs(ms))
}

function Rules({ anchors }: { anchors: Anchor[] }) {
  const mode =
    anchors.length === 0
      ? '当前为「无锚点」模式：所有字幕保留原始时间。'
      : anchors.length === 1
        ? `当前为「单锚点」模式：全部字幕整体平移 ${signedOffset(
            anchors[0].target - anchors[0].source,
          )}（正为延后、负为提前）。`
        : `当前为「多锚点」模式：${anchors.length} 个锚点之间分段线性映射，首尾沿最近区段斜率外推。`
  return (
    <div className="rules-bar">
      <span className="rules-dot" />
      {mode}
    </div>
  )
}
