import { useEffect, useRef, useState } from 'react'
import { formatTime } from '../lib/time'

interface Props {
  value: number
  /** 返回 true 表示提交被接受；false 表示非法，输入框将回退到上一个合法值。 */
  onSubmit: (text: string) => boolean
}

/** 行内锚点目标时间输入：Enter 提交、Esc 撤销、失焦提交；非法编辑不生效。 */
export default function TargetTimeInput({ value, onSubmit }: Props) {
  const [text, setText] = useState(() => formatTime(value))
  const [bad, setBad] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  // 外部 value 变化（如撤销）时同步显示
  useEffect(() => {
    setText(formatTime(value))
    setBad(false)
  }, [value])

  const commit = () => {
    const trimmed = text.trim()
    if (trimmed === formatTime(value)) {
      setText(formatTime(value))
      setBad(false)
      return
    }
    if (onSubmit(trimmed)) {
      setBad(false)
    } else {
      setBad(true)
      setText(formatTime(value))
    }
  }

  return (
    <input
      ref={ref}
      className={'time-input' + (bad ? ' invalid' : '')}
      value={text}
      spellCheck={false}
      autoComplete="off"
      aria-label="锚点目标时间"
      onChange={(e) => {
        setText(e.target.value)
        setBad(false)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setText(formatTime(value))
          setBad(false)
          ref.current?.blur()
        }
      }}
    />
  )
}
