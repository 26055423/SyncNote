/* eslint-disable */
/** bigwolf 的 Pine v6 源码：交给 Vela 的 Pine 引擎跑，指标面板里叫 bigwolf。 */
export const BIGWOLF_PINE = String.raw`
//@version=6
// ═══════════════════════════════════════════════════════════════════════════════
//  bigwolf · 同频移植版
//  Vegas 通道 + 时段（亚/欧/美）+ MACD + 0 轴穿越标记 + FVG + 内包 K + OB
//  作为 Vela 的 Pine 指标运行（指标面板里的「bigwolf」）。
// ═══════════════════════════════════════════════════════════════════════════════
indicator("bigwolf", shorttitle = "bigwolf", overlay = false, max_boxes_count = 500, max_lines_count = 500, max_labels_count = 500)

bool isIntraday = timeframe.isintraday

// ── ① MACD（副图） ───────────────────────────────────────────────────────────
string gMACD = "① MACD"
showMACD   = input.bool(true, "显示 MACD", group = gMACD)
macdFast   = input.int(12, "快线", minval = 1, group = gMACD)
macdSlow   = input.int(26, "慢线", minval = 1, group = gMACD)
macdSigLen = input.int(9, "信号线", minval = 1, group = gMACD)
showHist   = input.bool(true, "显示能量柱", group = gMACD)
hist4Color = input.bool(true, "动能双色", group = gMACD)
colMACD    = input.color(#2962FF, "MACD 线", group = gMACD)
colSignal  = input.color(#FF6D00, "信号线", group = gMACD)
colHistUp  = input.color(#26A69A, "柱·增强↑", group = gMACD)
colHistDn  = input.color(#EF5350, "柱·增强↓", group = gMACD)
showCross  = input.bool(true, "标注金叉 / 死叉", group = gMACD)

[macdLine, signalLine, histLine] = ta.macd(close, macdFast, macdSlow, macdSigLen)
bool crossUp = ta.crossover(macdLine, signalLine)
bool crossDn = ta.crossunder(macdLine, signalLine)

color histColor = histLine >= 0 ? (hist4Color and histLine < nz(histLine[1]) ? color.new(colHistUp, 62) : colHistUp) : (hist4Color and histLine > nz(histLine[1]) ? color.new(colHistDn, 62) : colHistDn)

plot(showMACD ? macdLine : na, "MACD", color = colMACD)
plot(showMACD ? signalLine : na, "信号线", color = colSignal)
plot(showHist ? histLine : na, "能量柱", style = plot.style_columns, color = histColor)
hline(0, "零轴", color = color.new(color.gray, 55), linestyle = hline.style_dotted)
plotshape(showCross and crossUp, "MACD 金叉", style = shape.triangleup, location = location.bottom, color = color.new(colHistUp, 0), size = size.tiny)
plotshape(showCross and crossDn, "MACD 死叉", style = shape.triangledown, location = location.top, color = color.new(colHistDn, 0), size = size.tiny)

// ── ② Vegas 通道（force_overlay 到主图） ────────────────────────────────────
string gVegas = "② Vegas 通道"
showVegas = input.bool(true, "显示 Vegas 通道", group = gVegas)
showV12   = input.bool(true, "短线", group = gVegas)
showTubeA = input.bool(true, "主通道", group = gVegas)
showTubeB = input.bool(true, "次通道", group = gVegas)
lenA0 = input.int(12, "EMA 12", minval = 1, group = gVegas)
colA0 = input.color(#FF9800, "颜色", group = gVegas)
lenA1 = input.int(144, "EMA 144", minval = 1, group = gVegas)
colA1 = input.color(#F23645, "颜色", group = gVegas)
lenA2 = input.int(169, "EMA 169", minval = 1, group = gVegas)
colA2 = input.color(#F23645, "颜色", group = gVegas)
lenB1 = input.int(576, "EMA 576", minval = 1, group = gVegas)
colB1 = input.color(#2962FF, "颜色", group = gVegas)
lenB2 = input.int(676, "EMA 676", minval = 1, group = gVegas)
colB2 = input.color(#2962FF, "颜色", group = gVegas)
fillTube  = input.bool(true, "填充通道", group = gVegas)
fillTrans = input.int(88, "填充透明度", minval = 0, maxval = 100, group = gVegas)

emaA0 = ta.ema(close, lenA0)
emaA1 = ta.ema(close, lenA1)
emaA2 = ta.ema(close, lenA2)
emaB1 = ta.ema(close, lenB1)
emaB2 = ta.ema(close, lenB2)

pA0 = plot(showVegas and showV12 ? emaA0 : na, "Vegas EMA 12", color = colA0, linewidth = 1, force_overlay = true)
pA1 = plot(showVegas and showTubeA ? emaA1 : na, "Vegas EMA 144", color = colA1, linewidth = 1, force_overlay = true)
pA2 = plot(showVegas and showTubeA ? emaA2 : na, "Vegas EMA 169", color = colA2, linewidth = 2, force_overlay = true)
pB1 = plot(showVegas and showTubeB ? emaB1 : na, "Vegas EMA 576", color = colB1, linewidth = 1, force_overlay = true)
pB2 = plot(showVegas and showTubeB ? emaB2 : na, "Vegas EMA 676", color = colB2, linewidth = 2, force_overlay = true)
fill(pA1, pA2, color = fillTube ? color.new(colA1, fillTrans) : na, title = "主通道填充")
fill(pB1, pB2, color = fillTube ? color.new(colB1, fillTrans) : na, title = "次通道填充")

// ── ③ 时段 ──────────────────────────────────────────────────────────────────
string gSess = "③ 时段 · 全局"
sessTz      = input.string("Asia/Shanghai", "时段时区", options = ["Asia/Shanghai", "America/New_York", "Europe/London", "Etc/UTC"], group = gSess)
sessExtend  = input.bool(true, "箱体延伸到预定收盘时间", group = gSess)
showSessBox = input.bool(true, "显示时段箱体", group = gSess)
showKzBox   = input.bool(true, "显示 Kill Zone 箱体", group = gSess)
sessTrans   = input.int(92, "时段箱体透明度", minval = 0, maxval = 100, group = gSess)
kzTrans     = input.int(86, "Kill Zone 透明度", minval = 0, maxval = 100, group = gSess)
keepBoxes   = input.int(6, "每个窗口保留箱体数", minval = 1, maxval = 40, group = gSess)

string gAsia = "③-1 亚盘"
asiaOn   = input.bool(true, "启用", group = gAsia)
asiaSess = input.session("0700-1530", "时段", group = gAsia)
colAsia  = input.color(#42A5F5, "颜色", group = gAsia)

string gLondon = "③-2 欧盘"
londonOn     = input.bool(true, "启用", group = gLondon)
londonSess   = input.session("1530-2330", "时段", group = gLondon)
colLondon    = input.color(#AB47BC, "颜色", group = gLondon)
londonKzOn   = input.bool(true, "启用 Kill Zone", group = gLondon)
londonKzSess = input.session("1530-1700", "时间", group = gLondon)
colLondonKz  = input.color(#7E57C2, "Kill Zone 颜色", group = gLondon)

string gNy = "③-3 美盘"
nyOn       = input.bool(true, "启用", group = gNy)
nySess     = input.session("2030-0500", "时段", group = gNy)
colNy      = input.color(#26A69A, "颜色", group = gNy)
nyAmKzOn   = input.bool(true, "启用上午 Kill Zone", group = gNy)
nyAmKzSess = input.session("2030-2330", "时间", group = gNy)
colNyAmKz  = input.color(#26A69A, "上午 KZ 颜色", group = gNy)
nyPmKzOn   = input.bool(true, "启用下午 Kill Zone", group = gNy)
nyPmKzSess = input.session("0200-0400", "时间", group = gNy)
colNyPmKz  = input.color(#FFA726, "下午 KZ 颜色", group = gNy)

string gLevel = "④ 时段高低点"
publishLevels = input.bool(true, "时段收线后延伸高低点", group = gLevel)
removeSwept   = input.bool(true, "被突破后删除", group = gLevel)
touchCounts   = input.bool(false, "影线触及即算突破", group = gLevel)
extendLevels  = input.bool(false, "高低点线延伸到右侧", group = gLevel)
keepLevels    = input.int(20, "最多保留条数", minval = 1, maxval = 60, group = gLevel)
levelWidth    = input.int(1, "线宽", minval = 1, maxval = 4, group = gLevel)

// ── ⑤ MACD 穿 0 轴标记 ─────────────────────────────────────────────────────
string gMark = "⑤ 穿 0 轴 · 高低点标记"
markOn     = input.bool(true, "启用标记", group = gMark)
markUp     = input.bool(true, "上穿 0 轴 → 标记最低点", group = gMark)
markDn     = input.bool(true, "下穿 0 轴 → 标记最高点", group = gMark)
markLbMax  = input.int(20, "回看上限", minval = 2, maxval = 200, group = gMark)
markTrack  = input.bool(true, "穿轴后持续更新劈开点", group = gMark)
mkEmojiLow = input.string("⚔️", "上穿时（低点）图标", group = gMark)
mkEmojiHi  = input.string("⚔️", "下穿时（高点）图标", group = gMark)
mkGapAtr   = input.float(0.15, "图标离 K 线（ATR 比例）", minval = 0, maxval = 5, step = 0.05, group = gMark)
mkShowPrc  = input.bool(false, "同时显示价格", group = gMark)
mkBgTrans  = input.int(85, "背景透明度", minval = 0, maxval = 100, group = gMark)
mkColLow   = input.color(#26A69A, "低点颜色", group = gMark)
mkColHigh  = input.color(#EF5350, "高点颜色", group = gMark)
mkKeep     = input.int(30, "只保留最近标记数", minval = 5, maxval = 500, group = gMark)

// ── ⑥ FVG ──────────────────────────────────────────────────────────────────
string gFvg = "⑥ FVG 缺口"
fvgOn       = input.bool(true, "显示 FVG 缺口", group = gFvg)
fvgShowBull = input.bool(true, "看涨缺口", group = gFvg)
fvgShowBear = input.bool(true, "看跌缺口", group = gFvg)
fvgNeedBody = input.bool(false, "只保留中轴 K 线同向的缺口", group = gFvg)
fvgShrink   = input.bool(true, "部分回补时收缩", group = gFvg)
fvgExtend   = input.bool(false, "FVG 向右延伸", group = gFvg)
fvgAfter    = input.string("删除", "完全填补后", options = ["删除", "变灰停止"], group = gFvg)
fvgKeep     = input.int(20, "每个方向保留数量", minval = 2, maxval = 200, group = gFvg)
colFvgBull  = input.color(#26A69A, "看涨颜色", group = gFvg)
colFvgBear  = input.color(#EF5350, "看跌颜色", group = gFvg)
fvgTrans    = input.int(82, "填充透明度", minval = 0, maxval = 100, group = gFvg)

// ── ⑦ 内包 K 线 ────────────────────────────────────────────────────────────
string gIb = "⑦ 内包 K 线"
ibOn     = input.bool(true, "标记内包 K 线（实体变橙）", group = gIb)
ibStrict = input.bool(false, "严格内包", group = gIb)
ibColor  = input.color(#FF9800, "实体颜色", group = gIb)
ibWick   = input.bool(false, "影线也变色", group = gIb)
ibTrans  = input.int(0, "透明度", minval = 0, maxval = 100, group = gIb)

// ── ⑧ OB 订单块 ────────────────────────────────────────────────────────────
string gOb = "⑧ OB 订单块"
obOn       = input.bool(true, "显示 OB 订单块", group = gOb)
obShowBull = input.bool(true, "看涨 OB（需求）", group = gOb)
obShowBear = input.bool(true, "看跌 OB（供给）", group = gOb)
obPivot    = input.int(5, "结构确认根数", minval = 2, maxval = 50, group = gOb)
obKeep     = input.int(5, "每个方向保留数量", minval = 1, maxval = 20, group = gOb)
obExtend   = input.bool(true, "OB 向右延伸", group = gOb)
obMitig    = input.string("影线触及", "失效判定", options = ["影线触及", "收盘突破"], group = gOb)
colObBull  = input.color(#089981, "看涨 OB 颜色", group = gOb)
colObBear  = input.color(#B22833, "看跌 OB 颜色", group = gOb)
obTrans    = input.int(80, "填充透明度", minval = 0, maxval = 100, group = gOb)

// ── 状态容器 ───────────────────────────────────────────────────────────────
var array<box>    sessionBoxes = array.new<box>()
var array<line>   levelLines   = array.new<line>()
var array<float>  levelPrices  = array.new<float>()
var array<int>    levelDirs    = array.new<int>()
var array<color>  levelColors  = array.new<color>()
var array<bool>   levelSwept   = array.new<bool>()

f_startMinutes(string sessRange) =>
    int(str.tonumber(str.substring(sessRange, 0, 2))) * 60 + int(str.tonumber(str.substring(sessRange, 2, 4)))

f_windowEnd(string sessRange, int refTime) =>
    int rawStart = f_startMinutes(sessRange)
    int rawEnd   = int(str.tonumber(str.substring(sessRange, 5, 7))) * 60 + int(str.tonumber(str.substring(sessRange, 7, 9)))
    int y = year(refTime, sessTz)
    int m = month(refTime, sessTz)
    int d = dayofmonth(refTime, sessTz)
    int minuteOfDay = hour(refTime, sessTz) * 60 + minute(refTime, sessTz)
    int startDay = d - (minuteOfDay < rawStart ? 1 : 0)
    int dayOffset = rawEnd <= rawStart ? 1 : 0
    timestamp(sessTz, y, m, startDay + dayOffset, int(rawEnd / 60), rawEnd % 60)

f_inWindow(string sessRange) =>
    int s0 = f_startMinutes(sessRange)
    int e0 = int(str.tonumber(str.substring(sessRange, 5, 7))) * 60 + int(str.tonumber(str.substring(sessRange, 7, 9)))
    int now = hour(time, sessTz) * 60 + minute(time, sessTz)
    e0 > s0 ? (now >= s0 and now < e0) : (now >= s0 or now < e0)

f_publishLevel(int originBar, float price, int dir, color lvlColor, int endBar) =>
    if not na(originBar) and not na(price) and publishLevels
        line ln = line.new(originBar, price, endBar, price, xloc = xloc.bar_index, extend = extendLevels ? extend.right : extend.none, color = lvlColor, width = levelWidth, force_overlay = true)
        array.push(levelLines, ln)
        array.push(levelPrices, price)
        array.push(levelDirs, dir)
        array.push(levelColors, lvlColor)
        array.push(levelSwept, false)
        while array.size(levelLines) > keepLevels
            line.delete(array.shift(levelLines))
            array.shift(levelPrices)
            array.shift(levelDirs)
            array.shift(levelColors)
            array.shift(levelSwept)

f_manageLevels() =>
    bool sweptHigh = false
    bool sweptLow  = false
    if array.size(levelLines) > 0
        for i = array.size(levelLines) - 1 to 0
            line ln = array.get(levelLines, i)
            float p = array.get(levelPrices, i)
            int dir = array.get(levelDirs, i)
            if not array.get(levelSwept, i)
                bool swept = dir == 1 ? (touchCounts ? high >= p : high > p) : (touchCounts ? low <= p : low < p)
                if swept
                    sweptHigh := sweptHigh or dir == 1
                    sweptLow  := sweptLow or dir == -1
                    if removeSwept
                        line.delete(ln)
                        array.remove(levelLines, i)
                        array.remove(levelPrices, i)
                        array.remove(levelDirs, i)
                        array.remove(levelColors, i)
                        array.remove(levelSwept, i)
                    else
                        array.set(levelSwept, i, true)
                        line.set_color(ln, color.new(array.get(levelColors, i), 65))
                        line.set_style(ln, line.style_dashed)
                        line.set_extend(ln, extend.none)
    [sweptHigh, sweptLow]

f_session(bool active, bool enabled, string sessName, string sessTime, color sessColor, int trans) =>
    var box   sessBox = na
    var float sHi = na
    var float sLo = na
    var int   sHiBar = na
    var int   sLoBar = na
    var int   sStart = na
    bool started = active and not active[1]
    bool ended   = active[1] and not active
    int schedEnd = f_windowEnd(sessTime, time)
    if started
        sHi := high
        sLo := low
        sHiBar := bar_index
        sLoBar := bar_index
        sStart := time
    if active
        if na(sHi) or high > sHi
            sHi := high
            sHiBar := bar_index
        if na(sLo) or low < sLo
            sLo := low
            sLoBar := bar_index
        if enabled and isIntraday
            if na(sessBox)
                sessBox := box.new(na(sStart) ? time : sStart, sHi, sessExtend ? schedEnd : time_close, sLo, xloc = xloc.bar_time, border_color = na, bgcolor = color.new(sessColor, trans), text = sessName, text_color = sessColor, text_size = size.small, text_halign = text.align_left, text_valign = text.align_top, force_overlay = true)
                array.push(sessionBoxes, sessBox)
                while array.size(sessionBoxes) > keepBoxes * 6
                    box.delete(array.shift(sessionBoxes))
            else
                box.set_right(sessBox, sessExtend ? schedEnd : time_close)
                box.set_top(sessBox, sHi)
                box.set_bottom(sessBox, sLo)
    if ended
        if enabled and isIntraday and not na(sessBox)
            box.set_right(sessBox, sessExtend ? f_windowEnd(sessTime, time[1]) : time_close[1])
            box.set_top(sessBox, sHi)
            box.set_bottom(sessBox, sLo)
        sessBox := na
        if not na(sHi) and not na(sLo)
            f_publishLevel(sHiBar, sHi, 1, sessColor, bar_index)
            f_publishLevel(sLoBar, sLo, -1, sessColor, bar_index)
    started

bool inAsia     = f_inWindow(asiaSess)
bool inLondon   = f_inWindow(londonSess)
bool inLondonKz = f_inWindow(londonKzSess)
bool inNy       = f_inWindow(nySess)
bool inNyAmKz   = f_inWindow(nyAmKzSess)
bool inNyPmKz   = f_inWindow(nyPmKzSess)

[levelSweptHigh, levelSweptLow] = f_manageLevels()

asiaStarted     = f_session(inAsia,     showSessBox and asiaOn,   "亚盘",   asiaSess,     colAsia,     sessTrans)
londonStarted   = f_session(inLondon,   showSessBox and londonOn, "欧盘",   londonSess,   colLondon,   sessTrans)
nyStarted       = f_session(inNy,       showSessBox and nyOn,     "美盘",   nySess,       colNy,       sessTrans)
londonKzStarted = f_session(inLondonKz, showKzBox and londonKzOn, "伦敦 KZ", londonKzSess, colLondonKz, kzTrans)
nyAmKzStarted   = f_session(inNyAmKz,   showKzBox and nyAmKzOn,   "美盘 AM KZ", nyAmKzSess, colNyAmKz, kzTrans)
nyPmKzStarted   = f_session(inNyPmKz,   showKzBox and nyPmKzOn,   "美盘 PM KZ", nyPmKzSess, colNyPmKz, kzTrans)

// ── ⑤ 穿零轴标记 ───────────────────────────────────────────────────────────
bool crossUpZero = ta.crossover(macdLine, 0.0)
bool crossDnZero = ta.crossunder(macdLine, 0.0)
float mkAtr = ta.atr(14)

f_markY(float p, bool isLow) => isLow ? p - mkGapAtr * nz(mkAtr) : p + mkGapAtr * nz(mkAtr)
f_markText(string sym, float p) => mkShowPrc ? sym + " " + str.tostring(p, format.mintick) : sym

var array<label> markLabels = array.new<label>()
var label liveLowMark   = na
var float liveLowPrice  = na
var bool  lowTracking   = false
var label liveHighMark  = na
var float liveHighPrice = na
var bool  highTracking  = false

if markOn and markUp and crossUpZero
    float best = na
    int bestOff = 0
    for i = 0 to markLbMax - 1
        if na(best) or low[i] < best
            best := low[i]
            bestOff := i
    if not na(best)
        if not na(liveHighMark)
            highTracking := false
        liveLowPrice := best
        lowTracking  := markTrack
        liveLowMark  := label.new(bar_index - bestOff, f_markY(best, true), f_markText(mkEmojiLow, best), xloc = xloc.bar_index, yloc = yloc.price, style = label.style_label_up, color = color.new(mkColLow, mkBgTrans), textcolor = color.white, size = size.normal, force_overlay = true)
        array.push(markLabels, liveLowMark)
        while array.size(markLabels) > mkKeep
            label.delete(array.shift(markLabels))

if markOn and markDn and crossDnZero
    float worst = na
    int worstOff = 0
    for i = 0 to markLbMax - 1
        if na(worst) or high[i] > worst
            worst := high[i]
            worstOff := i
    if not na(worst)
        if not na(liveLowMark)
            lowTracking := false
        liveHighPrice := worst
        highTracking  := markTrack
        liveHighMark  := label.new(bar_index - worstOff, f_markY(worst, false), f_markText(mkEmojiHi, worst), xloc = xloc.bar_index, yloc = yloc.price, style = label.style_label_down, color = color.new(mkColHigh, mkBgTrans), textcolor = color.white, size = size.normal, force_overlay = true)
        array.push(markLabels, liveHighMark)
        while array.size(markLabels) > mkKeep
            label.delete(array.shift(markLabels))

if lowTracking and not na(liveLowMark) and low < liveLowPrice
    liveLowPrice := low
    label.set_x(liveLowMark, bar_index)
    label.set_y(liveLowMark, f_markY(low, true))
    label.set_text(liveLowMark, f_markText(mkEmojiLow, low))

if highTracking and not na(liveHighMark) and high > liveHighPrice
    liveHighPrice := high
    label.set_x(liveHighMark, bar_index)
    label.set_y(liveHighMark, f_markY(high, false))
    label.set_text(liveHighMark, f_markText(mkEmojiHi, high))

// ── ⑥ FVG ─────────────────────────────────────────────────────────────────
var array<box>  fvgBullBox  = array.new<box>()
var array<bool> fvgBullLive = array.new<bool>()
var array<box>  fvgBearBox  = array.new<box>()
var array<bool> fvgBearLive = array.new<bool>()

bool fvgHist = not na(high[2]) and not na(low[2])
bool fvgBull = fvgHist and low > high[2] and (not fvgNeedBody or close[1] > open[1])
bool fvgBear = fvgHist and high < low[2] and (not fvgNeedBody or close[1] < open[1])

if fvgOn and fvgShowBull and fvgBull and barstate.isconfirmed
    box nb = box.new(bar_index - 1, low, bar_index + 1, high[2], xloc = xloc.bar_index, border_color = color.new(colFvgBull, 25), border_width = 1, bgcolor = color.new(colFvgBull, fvgTrans), force_overlay = true)
    array.push(fvgBullBox, nb)
    array.push(fvgBullLive, true)
    while array.size(fvgBullBox) > fvgKeep
        box.delete(array.shift(fvgBullBox))
        array.shift(fvgBullLive)

if fvgOn and fvgShowBear and fvgBear and barstate.isconfirmed
    box nb2 = box.new(bar_index - 1, low[2], bar_index + 1, high, xloc = xloc.bar_index, border_color = color.new(colFvgBear, 25), border_width = 1, bgcolor = color.new(colFvgBear, fvgTrans), force_overlay = true)
    array.push(fvgBearBox, nb2)
    array.push(fvgBearLive, true)
    while array.size(fvgBearBox) > fvgKeep
        box.delete(array.shift(fvgBearBox))
        array.shift(fvgBearLive)

if array.size(fvgBullBox) > 0
    for bi = array.size(fvgBullBox) - 1 to 0
        if array.get(fvgBullLive, bi)
            box bb = array.get(fvgBullBox, bi)
            if low <= box.get_bottom(bb)
                if fvgAfter == "删除"
                    box.delete(bb)
                    array.remove(fvgBullBox, bi)
                    array.remove(fvgBullLive, bi)
                else
                    array.set(fvgBullLive, bi, false)
                    box.set_bgcolor(bb, color.new(colFvgBull, 90))
            else
                if fvgShrink and low < box.get_top(bb)
                    box.set_top(bb, low)
                if fvgExtend
                    box.set_right(bb, bar_index + 1)

if array.size(fvgBearBox) > 0
    for si = array.size(fvgBearBox) - 1 to 0
        if array.get(fvgBearLive, si)
            box bs = array.get(fvgBearBox, si)
            if high >= box.get_top(bs)
                if fvgAfter == "删除"
                    box.delete(bs)
                    array.remove(fvgBearBox, si)
                    array.remove(fvgBearLive, si)
                else
                    array.set(fvgBearLive, si, false)
                    box.set_bgcolor(bs, color.new(colFvgBear, 90))
            else
                if fvgShrink and high > box.get_bottom(bs)
                    box.set_bottom(bs, high)
                if fvgExtend
                    box.set_right(bs, bar_index + 1)

// ── ⑦ 内包 K 线 ───────────────────────────────────────────────────────────
bool ibInside = not na(high[1]) and (ibStrict ? (high < high[1] and low > low[1]) : (high <= high[1] and low >= low[1]))
bool ibPaint  = ibOn and ibInside and barstate.isconfirmed
plotcandle(ibPaint ? open : na, ibPaint ? high : na, ibPaint ? low : na, ibPaint ? close : na, title = "内包 K 线", color = ibPaint ? color.new(ibColor, ibTrans) : na, wickcolor = ibPaint and ibWick ? color.new(ibColor, ibTrans) : na, bordercolor = ibPaint ? color.new(ibColor, ibTrans) : na, force_overlay = true)

// ── ⑧ OB ──────────────────────────────────────────────────────────────────
var array<float> obHiArr = array.new<float>()
var array<float> obLoArr = array.new<float>()
var array<int>   obTimeArr = array.new<int>()
var array<int>   obBase = array.new<int>()

array.push(obHiArr, high)
array.push(obLoArr, low)
array.push(obTimeArr, time)

float obPivHi = ta.pivothigh(high, obPivot, obPivot)
float obPivLo = ta.pivotlow(low, obPivot, obPivot)

var float obSwingHi = na
var int   obSwingHiBar = na
var bool  obHiCrossed = false
var float obSwingLo = na
var int   obSwingLoBar = na
var bool  obLoCrossed = false

if not na(obPivHi)
    obSwingHi := obPivHi
    obSwingHiBar := bar_index - obPivot
    obHiCrossed := false
if not na(obPivLo)
    obSwingLo := obPivLo
    obSwingLoBar := bar_index - obPivot
    obLoCrossed := false

var array<box> obBullBox = array.new<box>()
var array<box> obBearBox = array.new<box>()

bool obBreakUp = obOn and not obHiCrossed and not na(obSwingHi) and ta.crossover(close, obSwingHi)
bool obBreakDn = obOn and not obLoCrossed and not na(obSwingLo) and ta.crossunder(close, obSwingLo)

if obShowBull and obBreakUp
    obHiCrossed := true
    if bar_index - obSwingHiBar < array.size(obLoArr)
        box ob = box.new(bar_index - (bar_index - obSwingHiBar), obSwingHi, bar_index + 1, obSwingLo, xloc = xloc.bar_index, border_color = color.new(colObBull, 20), border_width = 1, bgcolor = color.new(colObBull, obTrans), force_overlay = true)
        array.push(obBullBox, ob)
        while array.size(obBullBox) > obKeep
            box.delete(array.shift(obBullBox))

if obShowBear and obBreakDn
    obLoCrossed := true
    box ob2 = box.new(bar_index - obPivot, obSwingHi, bar_index + 1, obSwingLo, xloc = xloc.bar_index, border_color = color.new(colObBear, 20), border_width = 1, bgcolor = color.new(colObBear, obTrans), force_overlay = true)
    array.push(obBearBox, ob2)
    while array.size(obBearBox) > obKeep
        box.delete(array.shift(obBearBox))

if array.size(obBullBox) > 0
    for oi = array.size(obBullBox) - 1 to 0
        box obb = array.get(obBullBox, oi)
        bool dead = obMitig == "收盘突破" ? close < box.get_bottom(obb) : low < box.get_bottom(obb)
        if dead
            box.delete(obb)
            array.remove(obBullBox, oi)
        else if obExtend
            box.set_right(obb, bar_index + 1)

if array.size(obBearBox) > 0
    for oj = array.size(obBearBox) - 1 to 0
        box obc = array.get(obBearBox, oj)
        bool dead2 = obMitig == "收盘突破" ? close > box.get_top(obc) : high > box.get_top(obc)
        if dead2
            box.delete(obc)
            array.remove(obBearBox, oj)
        else if obExtend
            box.set_right(obc, bar_index + 1)

alertcondition(asiaStarted, "进入亚盘", "{{ticker}} 进入亚盘时段")
alertcondition(londonStarted, "进入欧盘", "{{ticker}} 进入欧盘时段")
alertcondition(nyStarted, "进入美盘", "{{ticker}} 进入美盘时段")
alertcondition(crossUp, "MACD 金叉", "{{ticker}} MACD 金叉")
alertcondition(crossDn, "MACD 死叉", "{{ticker}} MACD 死叉")
alertcondition(crossUpZero, "MACD 上穿 0 轴", "{{ticker}} MACD 上穿 0 轴")
alertcondition(crossDnZero, "MACD 下穿 0 轴", "{{ticker}} MACD 下穿 0 轴")
alertcondition(fvgBull and barstate.isconfirmed, "出现看涨 FVG", "{{ticker}} 看涨 FVG")
alertcondition(fvgBear and barstate.isconfirmed, "出现看跌 FVG", "{{ticker}} 看跌 FVG")
alertcondition(ibPaint and barstate.isconfirmed, "出现内包 K 线", "{{ticker}} 内包 K 线")
`;
