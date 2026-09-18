import { parseTime, formatTime } from '../src/lib/time'
import { parseSrt, buildSrt, type Cue } from '../src/lib/srt'
import { buildAnchors, mapTimestamp, mapCues, validateMapped, type MappedLine } from '../src/lib/anchor'
import { activeLines, effectiveRange, seekTargetSec } from '../src/lib/sync'
import {
  normalizeText,
  parsePlan,
  previewPlan,
  serializePlan,
  type AnchorPlan,
} from '../src/lib/plan'
import { buildMergedSrt, computeMergePlan, legalEdge } from '../src/lib/merge'
import { buildCutSrt, computeCutPlan, mergeCuts, parseCutList, removedBefore } from '../src/lib/cut'
import { SAMPLE_SRT } from '../src/sample'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (cond) {
    console.log('  ✓', msg)
  } else {
    failures++
    console.error('  ✗ FAIL:', msg)
  }
}

// ---- time ----
console.log('time 解析/格式化')
assert(parseTime('00:00:01,500') === 1500, '1.5s 解析')
assert(parseTime('01:02:03.04') === 3723040, '点号分隔 1:02:03.04')
assert(parseTime('bad') === null, '非法时间返回 null')
assert(formatTime(3723040) === '01:02:03,040', '格式化')
assert(formatTime(-1500) === '-00:00:01,500', '负时间格式化带 -')
assert(parseTime(formatTime(123456789)) === 123456789, '往返一致')

// ---- map ----
console.log('无锚点：恒等')
assert(mapTimestamp(5000, []) === 5000, '保留原值')

console.log('单锚点：整体平移')
assert(mapTimestamp(1000, [{ source: 5000, target: 7000 }]) === 3000, '之前 +2000')
assert(mapTimestamp(9000, [{ source: 5000, target: 3000 }]) === 7000, '之后 -2000')

console.log('多锚点：分段线性 + 外推')
const a = [
  { source: 1000, target: 2000 },
  { source: 3000, target: 5000 },
  { source: 6000, target: 6000 },
]
assert(mapTimestamp(1000, a) === 2000, '锚点本身')
assert(mapTimestamp(2000, a) === 3500, '中点插值 (1k-3k 段斜率 1.5)')
assert(Math.abs(mapTimestamp(5000, a) - (5000 + 2000 / 3)) < 1e-9, '3k-6k 段插值 (斜率 1/3) ≈ 5666.67')
// 头部外推：斜率 1.5，t=0 => 2000 + (0-1000)*1.5 = 500
assert(mapTimestamp(0, a) === 500, '头部斜率外推')
// 尾部外推：斜率 1/3，t=9000 => 6000 + 3000/3 = 7000
assert(mapTimestamp(9000, a) === 7000, '尾部斜率外推')

console.log('锚点严格递增校验')
assert(buildAnchors([[1, 2]]) !== null, '单个锚点合法')
assert(buildAnchors([[1, 5], [2, 6]]) !== null, '双递增合法（乱序输入自动排序）')
assert(buildAnchors([[1, 5], [1, 6]]) === null, 'source 重复非法')
assert(buildAnchors([[1, 5], [2, 5]]) === null, 'target 相等非法')
assert(buildAnchors([[1, 5], [2, 4]]) === null, 'target 递减非法')
assert(buildAnchors([[2, 6], [1, 5]]) !== null, '乱序输入自动排序后合法')

// ---- SRT 解析 ----
console.log('SRT 解析')
const { cues, skipped } = parseSrt(SAMPLE_SRT)
assert(cues.length === 7, `示例解析出 7 条（实际 ${cues.length}）`)
assert(skipped === 0, '无跳过块')
assert(cues[0].id === '1' && cues[0].start === 1000 && cues[0].end === 4000, '第一条字段正确')
assert(cues[0].text.startsWith('欢迎使用'), '文本正确')

const crlf = parseSrt('1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nbye')
assert(crlf.cues.length === 2, 'CRLF 解析')
const dot = parseSrt('1\n00:00:01.500 --> 00:00:02.000\nx')
assert(dot.cues.length === 1 && dot.cues[0].start === 1500, '点号毫秒解析')
const bad = parseSrt('1\nnot a timing\nx\n\n2\n00:00:01,000 --> 00:00:02,000\ny')
assert(bad.cues.length === 1 && bad.skipped === 1, '非法块跳过并计数')
const bom = parseSrt('﻿1\n00:00:01,000 --> 00:00:02,000\nx')
assert(bom.cues.length === 1 && bom.cues[0].id === '1', 'UTF-8 BOM 被正确去除')

// ---- 导出：序号与文本不变 ----
console.log('SRT 导出')
const mapped = mapCues(cues, [])
const out = buildSrt(mapped)
const reparsed = parseSrt(out)
assert(reparsed.cues.length === 7, '导出后仍 7 条')
assert(
  reparsed.cues.every((c, i) => c.id === cues[i].id && c.text === cues[i].text),
  '序号与文本不变',
)
assert(
  reparsed.cues.every((c, i) => c.start === cues[i].start && c.end === cues[i].end),
  '无锚点导出时间不变',
)
assert(out.includes('00:00:01,000 --> 00:00:04,000'), '时间码格式正确')

// ---- 校验 ----
console.log('错误检测')
const noIssue = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: 1000, newEnd: 2000 },
  { index: 1, id: '2', start: 0, end: 1000, text: '', newStart: 2000, newEnd: 3000 },
])
assert(noIssue.size === 0, '正常时间线无错误')

const neg = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: -500, newEnd: 500 },
])
assert(neg.get(0)?.some((i) => i.kind === 'negative'), '负时间标红')

const nonpos = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: 2000, newEnd: 2000 },
])
assert(nonpos.get(0)?.some((i) => i.kind === 'nonpositive'), '零时长标红')

const overlap = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: 1000, newEnd: 3000 },
  { index: 1, id: '2', start: 0, end: 1000, text: '', newStart: 2000, newEnd: 4000 },
])
assert(
  overlap.get(1)?.some((i) => i.kind === 'overlap' && i.withId === '1'),
  '重叠标红并指向前一条 #1',
)

// ---- 端到端：示例 + 双锚点 ----
console.log('端到端')
const e2e = mapCues(cues, [
  { source: cues[0].start, target: 3000 },
  { source: cues[6].start, target: 60000 },
])
const e2eIssues = validateMapped(e2e)
assert(e2e[0].newStart === 3000, '第一条映射到目标 3s')
assert(e2e[6].newStart === 60000, '最后一条映射到目标 60s')
assert(e2e.every((l) => l.newStart >= 0 && l.newEnd > l.newStart), '外推后无非负/非正问题')

// ---- 视频同步预览：当前字幕计算 ----
console.log('视频同步：当前字幕')
const mkLine = (index: number, newStart: number, newEnd: number): MappedLine => ({
  index,
  id: String(index + 1),
  start: 0,
  end: 0,
  text: '',
  newStart,
  newEnd,
})
const ids = (list: MappedLine[]) => list.map((l) => l.id).join(',')

// 以校准后起止时间为准，区间左闭右开
const ov = [mkLine(0, 1000, 5000), mkLine(1, 3000, 7000)]
assert(ids(activeLines(ov, 999)) === '', '起始前无字幕')
assert(ids(activeLines(ov, 1000)) === '1', '起始时刻包含（左闭）')
assert(ids(activeLines(ov, 5000)) === '2', '结束时刻不包含（右开）')
assert(ids(activeLines(ov, 4000)) === '1,2', '时间重叠时按字幕顺序同时展示')
assert(ids(activeLines(ov, 6000)) === '2', '重叠区之后仅剩后一条')
assert(ids(activeLines(ov, 8000)) === '', '全部结束后无字幕')

// 负时间字幕不提前显示：起始钳到 0，结束时间不变
assert(effectiveRange(mkLine(0, -500, 1500)).join(',') === '0,1500', '负起始时间钳到 0')
const negStart = [mkLine(0, -500, 1500)]
assert(ids(activeLines(negStart, 0)) === '1', '负起始字幕从 t=0 起显示')
assert(ids(activeLines(negStart, 1499)) === '1' && ids(activeLines(negStart, 1500)) === '', '负起始字幕仍按原结束时间消失')
const allNeg = [mkLine(0, -2000, -1000)]
assert(ids(activeLines(allNeg, 0)) === '' && ids(activeLines(allNeg, 60000)) === '', '整体为负的字幕任何时刻都不显示')
const nonPos = [mkLine(0, 2000, 2000)]
assert(ids(activeLines(nonPos, 2000)) === '', '时长非正的字幕不显示')

// 锚点编辑（映射变化）后，同一播放时刻的命中集合立即变化
const identityLines = mapCues(cues, [])
assert(ids(activeLines(identityLines, 2000)) === '1', '校准前 t=2s 命中第 1 条')
const shiftedLines = mapCues(cues, [{ source: cues[0].start, target: cues[0].start + 10000 }])
assert(ids(activeLines(shiftedLines, 2000)) === '', '整体后移 10s 后 t=2s 不再命中')
assert(ids(activeLines(shiftedLines, 12000)) === '1', '整体后移 10s 后 t=12s 命中第 1 条')

// ---- 视频同步预览：点击跳转目标 ----
console.log('视频同步：点击跳转')
assert(seekTargetSec(3000, 10) === 3, '跳转目标为校准后起始时间（秒）')
assert(seekTargetSec(-1500, 10) === 0, '负起始时间钳到 0')
assert(seekTargetSec(20000, 10) === 10, '超出视频时长停在末尾')
assert(seekTargetSec(9500, 10) === 9.5, '时长之内不钳制')
assert(seekTargetSec(3000, NaN) === 3, '时长未知（元数据未加载）时不钳制')

// ---- 锚点方案：规范化 ----
console.log('文本规范化')
assert(normalizeText('  hello   world  ') === 'hello world', '去首尾空白并合并连续空白')
assert(normalizeText('a\r\n\t b') === 'a b', '换行/制表符合并为单空格')
assert(normalizeText('\n\n  \t') === '', '纯空白规范化为空串')

// ---- 锚点方案：序列化 + 往返 ----
console.log('方案导出/解析')
const planAnchors = [
  { source: cues[0].start, target: 3000 },
  { source: cues[3].start, target: 20000 },
  { source: cues[6].start, target: 60000 },
]
const planJson = serializePlan(cues, planAnchors)
assert(planJson !== null, 'serializePlan 返回 JSON')
const parsedPlan = parsePlan(planJson ?? '')
assert('plan' in parsedPlan && parsedPlan.plan.version === 1, '解析后版本号为 1')
assert('plan' in parsedPlan && parsedPlan.plan.anchors.length === 3, '解析出 3 个锚点')
assert(
  'plan' in parsedPlan &&
    parsedPlan.plan.anchors[0].text === normalizeText(cues[0].text) &&
    parsedPlan.plan.anchors[0].source === '00:00:01,000' &&
    parsedPlan.plan.anchors[0].target === '00:00:03,000',
  '首项时间与规范化文本正确',
)
assert(planJson?.split('\n').join('').includes('"version": 1'), 'JSON 带版本号')

const mkCue = (index: number, start: number, text: string): Cue => ({
  index,
  id: String(index + 1),
  start,
  end: start + 1000,
  text,
})
const t1 = '第一句'
const t2 = '第二句'
const t3 = '第三句'
const t4 = '第四句'
const mkPlan = (anchors: Array<[string, string, string]>): AnchorPlan => ({
  version: 1,
  anchors: anchors.map(([source, target, text]) => ({ source, target, text })),
})

// ---- 方案预览：全部直接匹配 ----
console.log('方案预览')
const plan1 = mkPlan([
  ['00:00:01,000', '00:00:03,000', t1],
  ['00:00:05,000', '00:00:08,000', t2],
])
const cur1 = [mkCue(0, 1000, t1), mkCue(1, 5000, t2)]
const pv1 = previewPlan(plan1, cur1)
assert(pv1.validCount === 2 && pv1.conflictCount === 0, '原始时间+文本相同 → 全部直接匹配')
assert(pv1.entries.every((e) => e.status === 'direct'), '状态均为 direct')
assert(pv1.anchors?.length === 2 && pv1.anchors[0].source === 1000, '生成的锚点正确')

// ---- 文本唯一但时间变了 → 迁移 ----
const cur2 = [mkCue(0, 2000, t1), mkCue(1, 9000, t2)]
const pv2 = previewPlan(plan1, cur2)
assert(pv2.entries.every((e) => e.status === 'migrated'), '时间变化、文本唯一 → 迁移')
assert(pv2.anchors?.[0].source === 2000 && pv2.anchors[0].target === 3000, '迁移后锚点绑定新原始时间、沿用目标时间')

// ---- 规范化后相同（多余空白）也能直接匹配 ----
const cur2b = [mkCue(0, 1000, `  ${t1}  `), mkCue(1, 5000, `${t2}\n第二行`.replace('第二句', '第二句'))]
const plan1b = mkPlan([
  ['00:00:01,000', '00:00:03,000', t1],
  ['00:00:05,000', '00:00:08,000', normalizeText(t2)],
])
const pv2b = previewPlan(plan1b, cur2b)
assert(pv2b.entries[0].status === 'direct', '首尾空白规范化后仍直接匹配')

// ---- 文本缺失 → 冲突 ----
const cur3 = [mkCue(0, 2000, t1), mkCue(1, 9000, '完全不同的句子')]
const pv3 = previewPlan(plan1, cur3)
assert(
  pv3.entries[0].status === 'migrated' &&
    pv3.entries[1].status === 'conflict' &&
    pv3.entries[1].conflictReason === 'missing',
  '文本找不到 → missing 冲突',
)
assert(pv3.validCount === 1, '仅 1 项有效')

// ---- 文本重复 → 冲突（时间又不同）----
const cur4 = [mkCue(0, 2000, t2), mkCue(1, 3000, t2), mkCue(2, 9000, t1)]
const pv4 = previewPlan(plan1, cur4)
assert(pv4.entries[1].status === 'conflict' && pv4.entries[1].conflictReason === 'duplicate', '重复文本 → duplicate 冲突')

// ---- 重复文本但原始时间也相同：优先直接匹配（唯一精确命中）----
const planDup = mkPlan([['00:00:02,000', '00:00:09,000', t2]])
const pv4b = previewPlan(planDup, cur4)
assert(pv4b.entries[0].status === 'direct', '时间+文本精确命中优先于重复判定')

// ---- 迁移破坏锚点顺序 → 冲突 ----
// 方案顺序 t1→t2→t3，当前字幕中 t3 排在 t1、t2 之前
const plan5 = mkPlan([
  ['00:00:01,000', '00:00:03,000', t1],
  ['00:00:05,000', '00:00:08,000', t2],
  ['00:00:09,000', '00:00:12,000', t3],
])
const cur5 = [mkCue(0, 1000, t3), mkCue(1, 2000, t1), mkCue(2, 6000, t2)]
const pv5 = previewPlan(plan5, cur5)
assert(
  pv5.entries[2].status === 'conflict' && pv5.entries[2].conflictReason === 'order',
  '迁移后落在首个有效锚点之前 → order 冲突',
)
assert(
  pv5.entries[0].status === 'migrated' && pv5.entries[1].status === 'migrated',
  '其余两项正常迁移',
)

// ---- 交叉迁移（迁移项与直接匹配交叉）→ 冲突 ----
const plan6 = mkPlan([
  ['00:00:01,000', '00:00:03,000', t1],
  ['00:00:05,000', '00:00:08,000', t2],
])
const cur6 = [mkCue(0, 5000, t2), mkCue(1, 6000, t1)]
const pv6 = previewPlan(plan6, cur6)
assert(
  pv6.entries[0].status === 'conflict' &&
    pv6.entries[0].conflictReason === 'order' &&
    pv6.entries[1].status === 'direct',
  '迁移项越过直接匹配锚点 → order 冲突，直接匹配保留',
)

// ---- 迁移导致锚点顺序被破坏（按匹配后原始时间重排）→ 冲突 ----
// 方案：t1(→10s) 在 t2(→20s) 之前；当前字幕 t2 在 t1 之前（时间也都变了，均走迁移）
const plan7 = mkPlan([
  ['00:00:01,000', '00:00:10,000', t1],
  ['00:00:05,000', '00:00:20,000', t2],
])
const cur7 = [mkCue(0, 1000, t2), mkCue(1, 5000, t1)]
const pv7 = previewPlan(plan7, cur7)
assert(pv7.conflictCount === 1, '顺序颠倒恰好一项冲突')
assert(
  pv7.entries[0].status === 'migrated' &&
    pv7.entries[1].status === 'conflict' &&
    pv7.entries[1].conflictReason === 'order',
  '迁移后顺序颠倒 → order 冲突（目标时间随之不再严格递增）',
)

// ---- 不替换文本：预览结果只携带时间，锚点不含文本副作用（结构性保证）----
assert(
  pv2.anchors?.every((a) => typeof a.source === 'number' && typeof a.target === 'number'),
  '应用数据仅含 source/target，不触碰字幕文本',
)

// ---- 方案文件：严格校验 ----
console.log('方案文件校验')
const expectError = (raw: string, code: string, msg: string) => {
  const r = parsePlan(raw)
  assert('error' in r && r.error.code === code, msg)
}
expectError('{not json', 'invalid-json', '非法 JSON 拒绝')
expectError('[]', 'invalid-shape', '顶层非对象拒绝')
expectError('{"anchors":[]}', 'invalid-shape', '缺 version 拒绝')
expectError('{"version": 2, "anchors": []}', 'unknown-version', '未知版本拒绝')
expectError('{"version": "1", "anchors": []}', 'unknown-version', '版本号类型错误拒绝')
expectError(
  JSON.stringify({
    version: 1,
    anchors: [
      { source: '00:00:01,000', target: '00:00:02,000', text: 'x' },
    ],
    exportedAt: 'today',
  }),
  'invalid-shape',
  '额外顶层字段拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [{ source: '00:00:01,000', target: '00:00:02,000', text: 'x', extra: 1 }],
  }),
  'invalid-anchor',
  '锚点含未知字段拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [{ source: 1000, target: 2000, text: 'x' }],
  }),
  'invalid-anchor',
  '时间非字符串拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [{ source: 'bad', target: '00:00:02,000', text: 'x' }],
  }),
  'invalid-anchor',
  '时间码无法解析拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [{ source: '00:00:01,000', target: '25:99:99,000', text: 'x' }],
  }),
  'invalid-anchor',
  '目标时间码非法拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [
      { source: '00:00:01,000', target: '00:00:05,000', text: 'x' },
      { source: '00:00:02,000', target: '00:00:04,000', text: 'y' },
    ],
  }),
  'invalid-anchor',
  '目标时间不严格递增拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [
      { source: '00:00:02,000', target: '00:00:03,000', text: 'x' },
      { source: '00:00:02,000', target: '00:00:04,000', text: 'y' },
    ],
  }),
  'invalid-anchor',
  '原始时间重复拒绝',
)
expectError(
  JSON.stringify({ version: 1, anchors: [{ source: '00:00:01,000', target: '00:00:02,000', text: '   ' }] }),
  'invalid-anchor',
  '规范化文本为空拒绝',
)
expectError(JSON.stringify({ version: 1, anchors: [] }), 'empty-anchors', '空锚点方案拒绝')

// 合法但带点号毫秒的时间可解析
const dotPlan = parsePlan(
  JSON.stringify({
    version: 1,
    anchors: [{ source: '00:00:01.500', target: '00:00:02,000', text: t4 }],
  }),
)
assert('plan' in dotPlan, '点号毫秒时间可被接受')

// 端到端：示例导出方案 → 同一份字幕重新导入，全部直接匹配且锚点一致
const e2ePlanJson = serializePlan(cues, [
  { source: cues[0].start, target: 3000 },
  { source: cues[6].start, target: 60000 },
])
const e2ePlanRes = parsePlan(e2ePlanJson ?? '')
assert('plan' in e2ePlanRes, '端到端方案解析成功')
if ('plan' in e2ePlanRes) {
  const e2ePreview = previewPlan(e2ePlanRes.plan, cues)
  assert(e2ePreview.validCount === 2, '同一份字幕 2 项全部直接匹配')
  assert(e2ePreview.entries.every((e) => e.status === 'direct'), '全部 direct')
  assert(
    e2ePreview.anchors?.[0].source === cues[0].start && e2ePreview.anchors[0].target === 3000,
    '端到端锚点值一致',
  )
}

// ---- 双语字幕合并 ----
console.log('双语合并：候选合法性')
assert(
  legalEdge({ start: 0, end: 4000 }, { start: 2000, end: 6000 })?.overlap === 2000,
  '正重叠返回重叠时长',
)
assert(
  legalEdge({ start: 0, end: 4000 }, { start: 2000, end: 6000 })?.startDelta === 2000,
  '起始时间差为绝对值',
)
assert(
  legalEdge({ start: 0, end: 4000 }, { start: 4000, end: 8000 }) === null,
  '仅端点相接（无正重叠）不合法',
)
assert(
  legalEdge({ start: 0, end: 4000 }, { start: 10000, end: 12000 }) === null,
  '完全不重叠不合法',
)
// 重叠 1900，较短者 4000，50% 为 2000 → 不合法
assert(
  legalEdge({ start: 0, end: 4000 }, { start: 2100, end: 6000 }) === null,
  '重叠不足较短字幕 50% 不合法',
)
// 重叠恰好 2000 = 4000 的 50% → 合法（“不少于”含边界）
assert(
  legalEdge({ start: 0, end: 4000 }, { start: 2000, end: 6000 }) !== null,
  '重叠恰好达到 50% 合法',
)
// 较短者是次轨：主 10s、次 2s，次轨全包含时重叠 2s 合法
assert(
  legalEdge({ start: 0, end: 10000 }, { start: 0, end: 2000 })?.overlap === 2000,
  '较短者为次轨：全包含 2s 合法',
)
assert(
  legalEdge({ start: 0, end: 10000 }, { start: 1000, end: 3000 })?.overlap === 2000,
  '较短者为次轨 2s、重叠 2s 全包含合法',
)
// 较短者为次轨 2s（[1000,3000]），重叠 900 < 1000（次轨半长）→ 不合法
assert(
  legalEdge({ start: 0, end: 1900 }, { start: 1000, end: 3000 }) === null,
  '较短者为次轨 2s、重叠 900 不足次轨 50% 不合法',
)
// 较短者是主轨：主 1s、次 10s，重叠恰 500ms = 主轨半长 → 合法
assert(
  legalEdge({ start: 1000, end: 2000 }, { start: 0, end: 10000 }) !== null,
  '较短者为主轨：重叠恰为 50% 合法',
)
// 较短者是主轨 1s（[600,1600]），与次轨 [0,1000] 重叠 400 < 500 → 不合法
assert(
  legalEdge({ start: 600, end: 1600 }, { start: 0, end: 1000 }) === null,
  '较短者为主轨：重叠不足主轨 50% 不合法',
)
assert(legalEdge({ start: 0, end: 0 }, { start: 0, end: 2000 }) === null, '主轨零时长不合法')
assert(legalEdge({ start: 2000, end: 1000 }, { start: 0, end: 2000 }) === null, '主轨负时长不合法')
assert(legalEdge({ start: 0, end: 2000 }, { start: 2000, end: 2000 }) === null, '次轨零时长不合法')

/** 构造校准后主轨行（newStart/newEnd 即校准后区间，原始字段供其他逻辑使用）。 */
const mkMain = (index: number, start: number, end: number, text: string): MappedLine => ({
  index,
  id: String(index + 1),
  start,
  end,
  text,
  newStart: start,
  newEnd: end,
})
const mkSec = (index: number, start: number, end: number, text: string): Cue => ({
  index,
  id: String(index + 1),
  start,
  end,
  text,
})
const edgePair = (plan: { edges: Array<{ mainIndex: number; secIndex: number }> }) =>
  plan.edges.map((e) => `${e.mainIndex}-${e.secIndex}`).join(',')

console.log('双语合并：顺序保持一对一')
{
  // 主 A[0,4] B[5,9]；次 X[0,4] Y[5,9]：完全对齐
  const main = [mkMain(0, 0, 4000, 'A'), mkMain(1, 5000, 9000, 'B')]
  const sec = [mkSec(0, 0, 4000, 'X'), mkSec(1, 5000, 9000, 'Y')]
  const p = computeMergePlan(main, sec)
  assert(p.edges.length === 2 && edgePair(p) === '0-0,1-1', '完全对齐：逐对匹配')
  assert(p.totalOverlap === 8000 && p.totalStartDelta === 0, '总重叠 8s、时差 0')
  assert(p.unmatchedMain.length === 0 && p.unmatchedSecondary.length === 0, '无未匹配项')
}

{
  // 交叉的一对一：主 A[0,4] B[5,9]；次 X 与 B 对齐、Y 与 A 对齐（时间不交叉）
  const main = [mkMain(0, 0, 4000, 'A'), mkMain(1, 5000, 9000, 'B')]
  const sec = [mkSec(0, 0, 4000, 'Y'), mkSec(1, 5000, 9000, 'X')]
  const p = computeMergePlan(main, sec)
  // 次轨按时间排列，仍然 0-0 / 1-1（匹配只看时间与顺序，与文本无关）
  assert(edgePair(p) === '0-0,1-1', '匹配基于时间轴顺序，与文本内容无关')
}

console.log('双语合并：最大化总重叠优先')
{
  // 主 A[0,4] B[4,8]；次 X[0,6] Y[6,8]
  // A-X ov4/d2, A-Y 不重叠; B-X ov2/d2, B-Y ov2/d2
  // (A-X,B-Y): ov=4+2=6；(A-X,B-X) 不可能（X 已用）；跳过 X：(B-Y) ov2；
  // 另：A-X(4)+B? B-Y(2)=6；A-X + B 无其他 → 6 为最优
  const main = [mkMain(0, 0, 4000, 'A'), mkMain(1, 4000, 8000, 'B')]
  const sec = [mkSec(0, 0, 6000, 'X'), mkSec(1, 6000, 8000, 'Y')]
  const p = computeMergePlan(main, sec)
  assert(p.totalOverlap === 6000, '总重叠最大化 = 6s')
  assert(edgePair(p) === '0-0,1-1', '两对都匹配')
}

{
  // 一对多的重叠权衡：主 A[0,10]；次 X[0,6] Y[4,10]
  // A-X ov6（6>=5 较短6的50%=3 ✓）；A-Y ov6；只能选一条（一对一，次序不可交叉）
  const main = [mkMain(0, 0, 10000, 'A')]
  const sec = [mkSec(0, 0, 6000, 'X'), mkSec(1, 4000, 10000, 'Y')]
  const p = computeMergePlan(main, sec)
  assert(p.edges.length === 1, '一对一：只能匹配一条次轨')
  assert(p.edges[0].secIndex === 0, '总重叠并列（6s）→ 时差更小（0 < 4000）选 X')
  assert(p.unmatchedSecondary.length === 1 && p.unmatchedSecondary[0] === 1, '另一条次轨列为未匹配')
}

{
  // 多对一的重叠权衡：主 A[0,6] B[4,10]；次 X[0,10]
  // A-X ov6, B-X ov6，只能匹配一条主轨
  const main = [mkMain(0, 0, 6000, 'A'), mkMain(1, 4000, 10000, 'B')]
  const sec = [mkSec(0, 0, 10000, 'X')]
  const p = computeMergePlan(main, sec)
  assert(p.edges.length === 1 && p.edges[0].mainIndex === 0, '并列时主序靠前的 A 匹配（次序号序列同为 [0]）')
  assert(p.unmatchedMain.length === 1 && p.unmatchedMain[0] === 1, '另一条主轨列为未匹配')
}

{
  // 次序号字典序：次 X[0,3] Y[3,6] 都只与主 A[0,6] 合法，重叠/时差均相同 → 取 X
  const main = [mkMain(0, 0, 6000, 'A')]
  const sec = [mkSec(0, 0, 3000, 'X'), mkSec(1, 3000, 6000, 'Y')]
  const p = computeMergePlan(main, sec)
  assert(p.edges[0].secIndex === 0, '完全并列选择次轨序号字典序更早的 X')
}

console.log('双语合并：起始时间差总和为次级目标')
{
  // 主 A[0,8] B[8,12]；次 X[0,6] Y[6,12]
  // 候选：A-X ov6 d0（较短6，半长3 ✓）；A-Y ov2（较短4半长2 ✓，恰50%）d8
  //       B-X ov2（较短6半长3，ov2<3 非法）；B-Y ov4 d2
  // 方案1 A-X+B-Y: ov10 d2；方案2 A-Y: ov2 d8；方案1 优
  const main = [mkMain(0, 0, 8000, 'A'), mkMain(1, 8000, 12000, 'B')]
  const sec = [mkSec(0, 0, 6000, 'X'), mkSec(1, 6000, 12000, 'Y')]
  const p = computeMergePlan(main, sec)
  assert(edgePair(p) === '0-0,1-1' && p.totalOverlap === 10000, '高重叠组合胜出')
  assert(p.totalStartDelta === 2000, '时差合计 2s')
}

{
  // 总重叠相同、时差不同：主 A[0,6] B[6,10]；次 X[1,5] Y[5,9]
  // A-X ov4 d1（较短4半长2 ✓），A-Y ov1（较短4半长2，1<2 非法）
  // B-X ov1（较短4半长2，非法），B-Y ov4 d1
  // 只能 A-X + B-Y（唯一合法组合）；补充一个纯时差并列场景见下
  const main = [mkMain(0, 0, 6000, 'A'), mkMain(1, 6000, 10000, 'B')]
  const sec = [mkSec(0, 1000, 5000, 'X'), mkSec(1, 5000, 9000, 'Y')]
  const p = computeMergePlan(main, sec)
  assert(edgePair(p) === '0-0,1-1' && p.totalStartDelta === 2000, '交叉不合法时按顺序匹配')
}

{
  // 纯时差裁决（总重叠相同）：主 A[0,4]；次 X[0,4]（d0）Y[1,5]（ov3 合法 d1）
  const main = [mkMain(0, 0, 4000, 'A')]
  const sec = [mkSec(0, 0, 4000, 'X'), mkSec(1, 1000, 5000, 'Y')]
  const p = computeMergePlan(main, sec)
  // A-X ov4 d0；A-Y ov3 d1 → 重叠不同，X 胜（验证重叠优先）
  assert(p.edges[0].secIndex === 0 && p.edges[0].overlap === 4000, '重叠优先于时差')
}

console.log('双语合并：未匹配清单')
{
  const main = [mkMain(0, 0, 4000, 'A'), mkMain(1, 100000, 104000, 'B')]
  const sec = [mkSec(0, 0, 4000, 'X'), mkSec(1, 200000, 204000, 'Y')]
  const p = computeMergePlan(main, sec)
  assert(edgePair(p) === '0-0', '只匹配时间重合的一对')
  assert(
    p.unmatchedMain.length === 1 &&
      p.unmatchedSecondary.length === 1 &&
      p.unmatchedMain[0] === 1 &&
      p.unmatchedSecondary[0] === 1,
    '双方未匹配条目分别列出',
  )
}

console.log('双语合并：导出沿用主轨时间码，次轨文本追加为下一行')
{
  const main = [
    mkMain(0, 0, 4000, '主文本一'),
    mkMain(1, 5000, 9000, '主文本二'),
    mkMain(2, 10000, 14000, '主文本三'),
  ]
  const sec = [mkSec(0, 0, 4000, 'SEC-ONE'), mkSec(1, 5000, 9000, 'SEC-TWO')]
  const p = computeMergePlan(main, sec)
  const out = buildMergedSrt(main, sec, p)
  const blocks = out.trim().split('\n\n')
  assert(blocks.length === 3, '导出条目数等于主轨条数')
  assert(
    blocks[0] === '1\n00:00:00,000 --> 00:00:04,000\n主文本一\nSEC-ONE',
    '已匹配：主文本 + 次轨文本追加为下一行，沿用主时间码与序号',
  )
  assert(
    blocks[1] === '2\n00:00:05,000 --> 00:00:09,000\n主文本二\nSEC-TWO',
    '第二条同样合并',
  )
  assert(blocks[2] === '3\n00:00:10,000 --> 00:00:14,000\n主文本三', '未匹配主轨照常导出且不追加')
  assert(!out.includes('SEC-') || (out.match(/SEC-/g) ?? []).length === 2, '次轨文本仅在匹配处出现')

  // 往返：再解析仍是 3 条
  const reparsed = parseSrt(out)
  assert(reparsed.cues.length === 3, '合并导出可被重新解析为 3 条')
  assert(
    reparsed.cues[0].text === '主文本一\nSEC-ONE',
    '合并文本（多行）在往返后保持',
  )
}

{
  // 小数毫秒的校准结果导出时四舍五入为合法时间码
  const main = [mkMain(0, 0, 1, 'A')]
  const sec = [mkSec(0, 0, 1, 'X')]
  main[0].newStart = 0.4
  main[0].newEnd = 1.6
  const p = computeMergePlan(main, sec)
  const out = buildMergedSrt(main, sec, p)
  assert(
    out.includes('00:00:00,000 --> 00:00:00,002'),
    '校准后的小数毫秒四舍五入后写入时间码',
  )
}

{
  // 次轨含多行文本：整块原样追加
  const main = [mkMain(0, 0, 4000, '主')]
  const sec = [mkSec(0, 0, 4000, '行1\n行2')]
  const p = computeMergePlan(main, sec)
  const out = buildMergedSrt(main, sec, p)
  assert(out.includes('主\n行1\n行2'), '次轨多行文本原样追加')
}

{
  // 规模上限保护：构造超过状态数上限的输入应抛出
  const bigMain = Array.from({ length: 4000 }, (_, i) => mkMain(i, i * 10, i * 10 + 5, 'M'))
  const bigSec = Array.from({ length: 4000 }, (_, i) => mkSec(i, i * 10, i * 10 + 5, 'S'))
  let threw = false
  try {
    computeMergePlan(bigMain, bigSec)
  } catch {
    threw = true
  }
  assert(threw, '状态数超过上限时抛出错误（由界面提示）')
}

console.log('双语合并：确定性小规模穷举对拍（最优重叠/时差/次序号字典序）')
{
  // 确定性 LCG，保证检查可复现
  let seed = 987654321
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
  const lexLess = (a: number[], b: number[]): boolean => {
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
      if (a[k] !== b[k]) return a[k] < b[k]
    }
    return a.length < b.length
  }
  /** 穷举全部顺序保持的匹配方案，返回与 computeMergePlan 同一优先级下的最优解。 */
  const brute = (ml: MappedLine[], sl: Cue[]) => {
    let best: { ov: number; df: number; seq: number[] } | null = null
    const rec = (i: number, j: number, ov: number, df: number, seq: number[]) => {
      if (i === ml.length || j === sl.length) {
        if (!best || ov > best.ov || (ov === best.ov && (df < best.df || (df === best.df && lexLess(seq, best.seq))))) {
          best = { ov, df, seq: [...seq] }
        }
        return
      }
      rec(i + 1, j, ov, df, seq)
      rec(i, j + 1, ov, df, seq)
      const leg = legalEdge(ml[i], sl[j])
      if (leg) rec(i + 1, j + 1, ov + leg.overlap, df + leg.startDelta, [...seq, j])
    }
    rec(0, 0, 0, 0, [])
    return best!
  }
  const track = (n: number, asMain: boolean) => {
    const arr: Array<MappedLine | Cue> = []
    let t = 0
    for (let i = 0; i < n; i++) {
      t += ri(0, 2500)
      const dur = ri(500, 4000)
      arr.push(asMain ? mkMain(i, t, t + dur, 'M') : mkSec(i, t, t + dur, 'S'))
      t += dur
      if (rnd() < 0.08) t += ri(0, 40000)
    }
    return arr
  }
  let fuzzFail = 0
  for (let trial = 0; trial < 400; trial++) {
    const ml = track(ri(1, 7), true) as MappedLine[]
    const sl = track(ri(1, 7), false) as Cue[]
    const plan = computeMergePlan(ml, sl)
    const b = brute(ml, sl)
    const seq = plan.edges.map((e) => e.secIndex)
    if (
      plan.totalOverlap !== b.ov ||
      plan.totalStartDelta !== b.df ||
      seq.length !== b.seq.length ||
      seq.some((v, k) => v !== b.seq[k])
    ) {
      fuzzFail++
    }
  }
  assert(fuzzFail === 0, `400 组随机输入与穷举最优解完全一致（偏差组数 ${fuzzFail}）`)
}

// ---- 删减清单重排：清单解析与逐项校验 ----
console.log('删减清单：解析校验')
{
  const r = parseCutList(
    JSON.stringify([
      { start: '00:00:10,000', end: '00:00:20,000' },
      { start: '00:01:00,000', end: '00:01:10,500' },
    ]),
  )
  assert('items' in r && r.items.length === 2, '合法数组解析为 2 项')
}
{
  const r = parseCutList('{not json')
  assert('errors' in r && r.errors[0].code === 'invalid-json', '非法 JSON 拒绝')
}
{
  const r = parseCutList('{}')
  assert('errors' in r && r.errors[0].code === 'invalid-shape', '顶层非数组拒绝')
}
{
  const r = parseCutList('[]')
  assert('errors' in r && r.errors.some((e) => e.code === 'empty-list'), '空清单拒绝')
}
{
  // 逐项报错：未知字段 + start 非字符串 + end 无法解析 + end<=start + 非对象
  const r = parseCutList(
    JSON.stringify([
      { start: '00:00:10,000', end: '00:00:20,000', extra: 1 },
      { start: 10000, end: '00:00:20,000' },
      { start: '00:00:10,000', end: 'bad' },
      { start: '00:00:20,000', end: '00:00:20,000' },
      'x',
    ]),
  )
  assert('errors' in r, '含非法项的整体清单被拒绝')
  assert('errors' in r && r.errors.length === 5, `逐项收集错误（实际 ${'errors' in r ? r.errors.length : 0}）`)
  assert(
    'errors' in r && r.errors.every((e) => e.message.startsWith('第 ')),
    '错误信息逐项标注序号（1 起）',
  )
}
{
  // 一项非法不应产出部分 items：整单拒绝由上层保留上次有效结果
  const r = parseCutList(
    JSON.stringify([
      { start: '00:00:10,000', end: '00:00:20,000' },
      { start: '00:00:30,000', end: '00:00:20,000' },
    ]),
  )
  assert('errors' in r && !('items' in r), '任一非法项时不返回部分有效项')
}
{
  const r = parseCutList(JSON.stringify([{ start: '00:00:01.500', end: '00:00:02,000' }]))
  assert('items' in r, '点号毫秒分隔的时间可接受')
}
{
  // 乱序、重叠、相接的输入交给 mergeCuts；解析器本身不要求有序
  const r = parseCutList(
    JSON.stringify([
      { start: '00:00:30,000', end: '00:00:40,000' },
      { start: '00:00:10,000', end: '00:00:20,000' },
    ]),
  )
  assert('items' in r && r.items.length === 2, '解析不要求清单有序')
}

// ---- 排序与合并 ----
console.log('删减清单：排序并合并相交/相接区间')
{
  const r = parseCutList(
    JSON.stringify([
      { start: '00:00:30,000', end: '00:00:42,000' }, // 与 [20,40] 相交
      { start: '00:00:10,000', end: '00:00:20,000' },
      { start: '00:00:20,000', end: '00:00:40,000' }, // 与首段相接
      { start: '00:01:00,000', end: '00:01:05,000' }, // 独立段
      { start: '00:01:02,000', end: '00:01:03,000' }, // 被包含
    ]),
  )
  const ranges = 'items' in r ? mergeCuts(r.items) : []
  assert(ranges.length === 2, `合并为 2 段（实际 ${ranges.length}）`)
  assert(ranges[0].start === 10000 && ranges[0].end === 42000, '相交/相接/被包含合并为 [10s,42s]')
  assert(ranges[1].start === 60000 && ranges[1].end === 65000, '独立段保留 [60s,65s]')
}

// ---- 累计删减时长 ----
console.log('删减清单：累计删减时长（末端相等不计入）')
{
  const ranges = mergeCuts(
    (parseCutList(
      JSON.stringify([
        { start: '00:00:10,000', end: '00:00:20,000' },
        { start: '00:00:30,000', end: '00:00:40,000' },
      ]),
    ) as { items: { start: string; end: string }[] }).items,
  )
  assert(removedBefore(ranges, 5000) === 0, '删减段之前为 0')
  assert(removedBefore(ranges, 15000) === 0, '位于第一段之内为 0')
  assert(removedBefore(ranges, 20000) === 10000, '恰在第一段末端：计入 10s')
  assert(removedBefore(ranges, 35000) === 10000, '第二段之内仍只计 10s')
  assert(removedBefore(ranges, 40000) === 20000, '第二段末端计入 20s')
}

// ---- 扣除重排 ----
console.log('删减清单：移除 / 拆分 / 前移 / 保留')
const cutItems2 = (
  parseCutList(
    JSON.stringify([
      { start: '00:00:10,000', end: '00:00:20,000' },
      { start: '00:00:30,000', end: '00:00:44,000' },
    ]),
  ) as { items: { start: string; end: string }[] }
).items
const cutRanges = mergeCuts(cutItems2)
const cutLines = [
  mkMain(0, 0, 8000, 'A'), // 删减之前：原样保留
  mkMain(1, 8000, 25000, 'B'), // 跨越第一段边界：拆成 [8,10) 与 [20,25)
  mkMain(2, 26000, 28000, 'C'), // 第一段之后：整段前移 10s
  mkMain(3, 30000, 38000, 'D'), // 完全落入第二段：移除
  mkMain(4, 44000, 50000, 'E'), // 从第二段末端开始：前移 24s
]
{
  const plan = computeCutPlan(cutLines, cutRanges)
  const st = plan.results.map((x) => x.status).join(',')
  assert(st === 'kept,split,shifted,removed,shifted', `处置序列正确（实际 ${st}）`)
  assert(
    plan.removed === 1 && plan.split === 1 && plan.shifted === 2 && plan.kept === 1,
    '移除/拆分/前移/保留计数正确',
  )
  assert(plan.fragmentCount === 5, `导出片段共 5 条（实际 ${plan.fragmentCount}）`)

  const a = plan.results[0]
  assert(
    a.fragments.length === 1 &&
      a.fragments[0].outStart === 0 &&
      a.fragments[0].outEnd === 8000 &&
      a.fragments[0].shift === 0,
    'A 原样保留、不平移',
  )

  const b = plan.results[1]
  assert(b.fragments.length === 2 && b.fragments.every((f) => f.text === 'B'), 'B 拆成 2 个非空片段且文本均保留为 B')
  assert(
    b.fragments[0].segStart === 8000 &&
      b.fragments[0].segEnd === 10000 &&
      b.fragments[0].outStart === 8000 &&
      b.fragments[0].outEnd === 10000,
    'B 片段 1：[8s,10s)，此前删减为 0 不平移',
  )
  assert(
    b.fragments[1].segStart === 20000 &&
      b.fragments[1].segEnd === 25000 &&
      b.fragments[1].outStart === 10000 &&
      b.fragments[1].outEnd === 15000 &&
      b.fragments[1].shift === 10000,
    'B 片段 2：[20s,25s) 按累计删减 10s 前移到 [10s,15s)',
  )

  const c = plan.results[2]
  assert(
    c.fragments[0].segStart === 26000 &&
      c.fragments[0].outStart === 16000 &&
      c.fragments[0].outEnd === 18000,
    'C [26s,28s) 前移 10s 到 [16s,18s)',
  )

  const d = plan.results[3]
  assert(d.status === 'removed' && d.fragments.length === 0, 'D 完全落入删减段，无片段')

  const e = plan.results[4]
  assert(
    e.fragments[0].segStart === 44000 &&
      e.fragments[0].outStart === 20000 &&
      e.fragments[0].outEnd === 26000 &&
      e.fragments[0].shift === 24000,
    'E 从删减段末端开始，按累计删减 24s 前移到 [20s,26s)',
  )
}

console.log('删减清单：相接边界与非正时长字幕')
{
  // 末端恰好相接不算相交：字幕 [5s,10s) 与删减段 [10s,20s) 不相扣
  const touch = computeCutPlan([mkMain(0, 5000, 10000, 'T')], cutRanges)
  assert(touch.results[0].status === 'kept', '字幕末端恰接删减段起点：原样保留')
  // 起点恰接删减段末端：字幕保留但按累计删减前移
  const after = computeCutPlan([mkMain(0, 20000, 25000, 'T')], cutRanges)
  assert(
    after.results[0].status === 'shifted' && after.results[0].fragments[0].outStart === 10000,
    '字幕起点恰接删减段末端：保留并前移 10s',
  )
  // 与删减段完全重合：移除
  const equal = computeCutPlan([mkMain(0, 10000, 20000, 'T')], cutRanges)
  assert(equal.results[0].status === 'removed', '字幕与删减段完全重合：移除')
  // 被删减段完全包含：移除
  const inside = computeCutPlan([mkMain(0, 31000, 32000, 'T')], cutRanges)
  assert(inside.results[0].status === 'removed', '字幕被删减段完全包含：移除')
  // 非正时长字幕与删减段相交：移除
  const degBad = computeCutPlan([mkMain(0, 15000, 15000, 'X')], cutRanges)
  assert(degBad.results[0].status === 'removed', '零时长字幕落入删减段：移除')
  // 非正时长字幕不相交：原样保留
  const degOk = computeCutPlan([mkMain(0, 2000, 2000, 'X')], cutRanges)
  assert(degOk.results[0].status === 'kept', '零时长字幕不相交：原样保留')
}

console.log('删减清单：一条字幕被多个删减段切成多个片段')
{
  // [8s,45s) 被 [10,20) 与 [30,44) 切成 [8,10) [20,30) [44,45) 三段
  const plan = computeCutPlan([mkMain(0, 8000, 45000, 'M')], cutRanges)
  const r = plan.results[0]
  assert(r.status === 'split' && r.fragments.length === 3, '切成 3 个非空片段')
  const outs = r.fragments.map((f) => `${f.outStart}-${f.outEnd}/${f.shift}`).join(',')
  assert(
    outs === '8000-10000/0,10000-20000/10000,20000-21000/24000',
    `三段平移量逐段累计正确（实际 ${outs}）`,
  )
  assert(r.fragments.every((f) => f.text === 'M'), '每个片段保留原文本')
}

console.log('删减清单：导出 .cut.srt 从 1 重编号')
{
  const plan = computeCutPlan(cutLines, cutRanges)
  const out = buildCutSrt(plan)
  const blocks = out.trim().split('\n\n')
  assert(blocks.length === 5, `导出 5 个片段块（实际 ${blocks.length}）`)
  const ids = blocks.map((b) => b.split('\n')[0]).join(',')
  assert(ids === '1,2,3,4,5', '序号按结果顺序从 1 重编号')
  const texts = blocks.map((b) => b.split('\n').slice(2).join('\n'))
  assert(texts.join('|') === 'A|B|B|C|E', `片段文本按结果顺序保留（实际 ${texts.join('|')}）`)
  assert(blocks[1] === '2\n00:00:08,000 --> 00:00:10,000\nB', '第 2 块为 B 的拆分片段 1')
  assert(blocks[2] === '3\n00:00:10,000 --> 00:00:15,000\nB', '第 3 块为 B 的拆分片段 2（已前移）')
  assert(!out.includes('D'), '被移除的 D 不写入文件')
  // 导出结果可重新解析为合法 SRT
  const reparsed = parseSrt(out)
  assert(reparsed.cues.length === 5, '导出文件可重新解析为 5 条')
}

{
  // 全部移除时导出为空串（界面禁用导出按钮）
  const plan = computeCutPlan([mkMain(0, 10000, 20000, 'X')], cutRanges)
  assert(plan.fragmentCount === 0 && buildCutSrt(plan) === '', '无残留片段时导出为空')
}

{
  // 小数毫秒校准结果四舍五入写入
  const fracLines = [mkMain(0, 0, 15000, 'X')]
  fracLines[0].newEnd = 15000.6
  const plan = computeCutPlan(fracLines, cutRanges)
  const out = buildCutSrt(plan)
  assert(out.includes('00:00:00,000 --> 00:00:10,000'), '片段边界的小数毫秒四舍五入')
}

console.log('删减清单：锚点变化后实时重算（集成 mapCues）')
{
  // 主轨原始字幕 [0,25s)：无锚点时被删减段 [10,20) 拆成 [0,10) / [20,25) 两段；
  // 设整体延后 10s 的单锚点后校准为 [10,35s)，前段与 [10,20) 完全重合被扣除，
  // 仅余 [20,30s) 单片段并按累计删减 10s 前移。
  const base = [{ index: 0, id: '1', start: 0, end: 25000, text: 'X' }]
  const p0 = computeCutPlan(mapCues(base, []), cutRanges)
  assert(p0.results[0].status === 'split' && p0.results[0].fragments.length === 2, '无锚点时 [0,25s) 被 [10,20) 拆成两段')
  const p1 = computeCutPlan(mapCues(base, [{ source: 0, target: 10000 }]), cutRanges)
  assert(
    p1.results[0].status === 'shifted' &&
      p1.results[0].fragments[0].segStart === 20000 &&
      p1.results[0].fragments[0].outStart === 10000,
    '锚点变化后同一条字幕重算为单片段并按累计删减前移',
  )
}

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
