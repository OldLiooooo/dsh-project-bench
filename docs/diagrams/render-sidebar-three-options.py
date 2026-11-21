# -*- coding: utf-8 -*-
"""DSH 左侧栏「工作区浏览区」三种改法 —— 对比示意图（图标全部用形状绘制，避免缺字）。"""
import math, os
from PIL import Image, ImageDraw, ImageFont

S = 2
W, H = 1300, 1268

BG = (255, 255, 255)
INK = (17, 24, 39)
SOFT = (55, 65, 81)
MUTED = (107, 114, 128)
LINE = (209, 213, 219)
PANEL = (250, 250, 251)

OFF_F = (233, 236, 239); OFF_L = (156, 163, 175)
OUR_F = (219, 234, 254); OUR_L = (59, 130, 246)
ADD_F = (220, 252, 231); ADD_L = (34, 197, 94)
LOST_F = (254, 226, 226); LOST_L = (239, 68, 68)
WARN_F = (254, 249, 195); WARN_L = (234, 179, 8)

F_REG = "C:/Windows/Fonts/msyh.ttc"
F_BLD = "C:/Windows/Fonts/msyhbd.ttc"
_c = {}

def font(size, bold=False):
    k = (size, bold)
    if k not in _c:
        _c[k] = ImageFont.truetype(F_BLD if bold else F_REG, size * S, index=0)
    return _c[k]

img = Image.new("RGB", (W * S, H * S), BG)
d = ImageDraw.Draw(img)

def rect(x, y, w, h, fill=None, outline=None, width=1, radius=6):
    d.rounded_rectangle([x*S, y*S, (x+w)*S, (y+h)*S], radius=radius*S,
                        fill=fill, outline=outline, width=int(round(max(1.0, width)*S)))

def text(x, y, s, size=13, bold=False, color=INK, anchor="la"):
    d.text((x*S, y*S), s, font=font(size, bold), fill=color, anchor=anchor)

def line(x1, y1, x2, y2, color=LINE, width=1):
    d.line([x1*S, y1*S, x2*S, y2*S], fill=color, width=int(round(max(1.0, width)*S)))

def _tokens(s):
    """CJK 逐字断行；拉丁词/数字/代码标识整词断行；空格单独成 token。"""
    out, buf = [], ""
    def flush():
        nonlocal buf
        if buf:
            out.append(buf); buf = ""
    for ch in s:
        if ch == "\n":
            flush(); out.append("\n"); continue
        if ord(ch) > 0x2E80 or ch in "，。；：、「」（）—…·×→←↔“”":
            flush(); out.append(ch)
        elif ch == " ":
            flush(); out.append(" ")
        else:
            buf += ch
    flush()
    return out

def wrap(s, size, maxw, bold=False):
    f = font(size, bold); out, cur = [], ""
    for tk in _tokens(s):
        if tk == "\n":
            out.append(cur); cur = ""; continue
        if tk == " ":
            if cur:
                cur += " "
            continue
        closing = "。，、；：）」』】！？…%,.;:)" 
        if f.getlength(cur + tk) / S > maxw and cur.strip() and tk not in closing:
            out.append(cur.rstrip()); cur = tk
        else:
            cur += tk
    out.append(cur)
    return out

def para(x, y, s, size=11, maxw=330, lh=1.55, color=SOFT, bold=False):
    for ln in wrap(s, size, maxw, bold):
        text(x, y, ln, size=size, color=color, bold=bold); y += size*lh
    return y

# ---------------------------------------------------------------- drawn icons
def ic_badge(x, y, n, r=9, fill=(59, 130, 246), fg=(255, 255, 255)):
    d.ellipse([x*S, y*S, (x+2*r)*S, (y+2*r)*S], fill=fill)
    text(x+r, y+r-0.5, str(n), size=max(8, int(r*1.25)), bold=True, color=fg, anchor="mm")

def ic_tri_down(cx, cy, s=3.2, color=MUTED):
    d.polygon([((cx-s)*S, (cy-s*0.5)*S), ((cx+s)*S, (cy-s*0.5)*S), (cx*S, (cy+s*0.9)*S)], fill=color)

def ic_tri_right(cx, cy, s=3.2, color=MUTED):
    d.polygon([((cx-s*0.5)*S, (cy-s)*S), ((cx-s*0.5)*S, (cy+s)*S), ((cx+s*0.9)*S, cy*S)], fill=color)

def ic_search(cx, cy, s=3.4, color=MUTED):
    d.ellipse([(cx-s)*S, (cy-s)*S, (cx+s*0.6)*S, (cy+s*0.6)*S], outline=color, width=int(round(1.2*S)))
    line(cx+s*0.5, cy+s*0.5, cx+s*1.5, cy+s*1.5, color, 1.3)

def ic_sliders(cx, cy, w=7, color=MUTED):
    for i, off in enumerate((-3.4, 0, 3.4)):
        line(cx-w, cy+off, cx+w, cy+off, color, 1)
        px = cx + (2.4 if i == 1 else -1.6)
        d.ellipse([(px-1.4)*S, (cy+off-1.4)*S, (px+1.4)*S, (cy+off+1.4)*S], fill=color)

def ic_kebab(cx, cy, color=MUTED):
    for off in (-3.2, 0, 3.2):
        d.ellipse([(cx-1.1)*S, (cy+off-1.1)*S, (cx+1.1)*S, (cy+off+1.1)*S], fill=color)

def ic_plus(cx, cy, s=3.6, color=ADD_L):
    line(cx-s, cy, cx+s, cy, color, 1.4); line(cx, cy-s, cx, cy+s, color, 1.4)

def ic_cross(cx, cy, s=3.4, color=LOST_L):
    line(cx-s, cy-s, cx+s, cy+s, color, 1.4); line(cx-s, cy+s, cx+s, cy-s, color, 1.4)

def ic_check(cx, cy, s=3.6, color=ADD_L):
    line(cx-s, cy, cx-s*0.15, cy+s*0.8, color, 1.6); line(cx-s*0.15, cy+s*0.8, cx+s, cy-s*0.8, color, 1.6)

def ic_gear(cx, cy, r=3.6, color=MUTED):
    d.ellipse([(cx-r)*S, (cy-r)*S, (cx+r)*S, (cy+r)*S], outline=color, width=int(round(1.2*S)))
    d.ellipse([(cx-r*0.35)*S, (cy-r*0.35)*S, (cx+r*0.35)*S, (cy+r*0.35)*S], fill=color)

def ic_square(cx, cy, s=8, fill=(236, 239, 242), outline=(215, 219, 224)):
    rect(cx-s/2, cy-s/2, s, s, fill=fill, outline=outline, radius=3)

def ic_dot(cx, cy, r=1.7, color=MUTED):
    d.ellipse([(cx-r)*S, (cy-r)*S, (cx+r)*S, (cy+r)*S], fill=color)

# ================================================================ title
text(40, 26, "左侧栏「工作区浏览区」的三种改法", size=26, bold=True)
text(40, 66, "三张图都是同一条左侧栏。灰＝官方原装　蓝＝我们自己写的代码　绿＝能安全加上的东西　红＝会被弄丢的能力",
     size=12, color=MUTED)

# ================================================================ 0 anatomy
text(40, 104, "0 · 现状：这块区域官方长什么样，我们现在占了哪一格", size=15, bold=True)

AX, AY, AW, AH = 40, 138, 268, 330

def sidebar_frame(x, y, w, h, our_icon=True):
    rect(x, y, w, h, fill=PANEL, outline=LINE, radius=8)
    rect(x+1, y+1, w-2, 26, fill=(243, 244, 246), radius=8)
    text(x+11, y+8, "DeepSeek", size=9, color=MUTED)
    iy = y+36
    for i in range(3):
        cx = x+22 + i*26; cy = iy+9
        on = our_icon and i == 1
        rect(cx-9, cy-9, 18, 18, fill=OUR_F if on else (236, 239, 242),
             outline=OUR_L if on else (215, 219, 224), radius=4)
        if on:
            rect(cx-3.5, cy-3.5, 7, 7, fill=(37, 99, 235), radius=1)
    hy = y+64
    text(x+11, hy-1, "工作区", size=10, bold=True)
    ic_search(x+w-46, hy+6)
    ic_sliders(x+w-22, hy+6)
    return iy+9, hy

icon_y, hy = sidebar_frame(AX, AY, AW, AH)
ay = hy + 20

rect(AX+8, ay, AW-16, 21, fill=OFF_F, outline=OFF_L, radius=5)
ic_tri_down(AX+17, ay+10.5)
text(AX+26, ay+2, "工作区 A", size=9)
ic_kebab(AX+AW-18, ay+10.5)

for i, lbl in enumerate(["会话 1", "会话 2", "会话 3"]):
    ry = ay+27 + i*18
    rect(AX+8, ry, AW-16, 16, fill=(246, 247, 249), radius=4)
    ic_dot(AX+17, ry+8)
    text(AX+24, ry+1, lbl, size=9, color=MUTED)
    rect(AX+AW-26, ry+4.5, 14, 10, fill=OFF_F, outline=OFF_L, radius=3)

ry = ay+84
rect(AX+8, ry, AW-16, 18, fill=(246, 247, 249), radius=4)
ic_tri_right(AX+17, ry+9)
text(AX+26, ry+2, "工作区 B", size=9, color=MUTED)

fy = AY+AH-28
line(AX+8, fy-7, AX+AW-8, fy-7)
ic_gear(AX+18, fy+6)
text(AX+27, fy+0, "设置", size=9, color=MUTED)

# numbered badges in the gutter
BX = AX + AW + 9
ic_badge(BX, icon_y-6, 1)
ic_badge(BX, hy-1, 2)
ic_badge(BX, ay+2, 3)
ic_badge(BX, ay+31, 4)
ic_badge(BX, fy-2, 5)

cx = 366
callouts = [
    ("品牌行 + 全局面板图标", "我们现在的「项目工作台」图标就注册在这一排（sidebar.panellist）。这块本来就是加法位，可以随便加。", OUR_F, OUR_L),
    ("分区标题「工作区」+ 搜索 + 视图选项", "最右那个滑杆「视图选项」下拉（分组方式 / 排序方式 / 隐藏归档）是组件里写死的，没有任何 slot 能插进去。", WARN_F, WARN_L),
    ("工作区行 + 行尾「…」菜单", "0.2.2 改成了上下文菜单注册表（target=workspace）。只能加自己 id 的一项，官方「重命名 / 删除」那两项替换不掉。", OFF_F, OFF_L),
    ("会话行 + 行尾按钮（归档 / 置顶）", "这些是 sidebar.workspaces 的子槽。规则：谁占用这块浏览区，谁才能渲染这些子槽里的东西。", OFF_F, OFF_L),
    ("侧栏底部", "sidebar.footer.action 是 list 槽，可以自由往这里加按钮。", ADD_F, ADD_L),
]
cy = 138
for i, (head, desc, fill, outl) in enumerate(callouts):
    hh = 60
    rect(cx, cy, W-cx-40, hh, fill=fill, outline=outl, radius=6)
    ic_badge(cx+13, cy+11, i+1, r=8)
    text(cx+30, cy+8, head, size=11, bold=True)
    para(cx+30, cy+27, desc, size=10, maxw=W-cx-76, lh=1.45)
    cy += hh+7

# ================================================================ 1 columns
text(40, 492, "1 · 三个方案分别动哪一块", size=15, bold=True)
lx = 40
for label, fill, outl in [("官方原装（不动）", OFF_F, OFF_L), ("我们的代码", OUR_F, OUR_L),
                          ("能安全加的点", ADD_F, ADD_L), ("会丢的能力", LOST_F, LOST_L),
                          ("待验证的问题", WARN_F, WARN_L)]:
    rect(lx, 522, 14, 14, fill=fill, outline=outl, radius=3)
    text(lx+19, 522, label, size=11, color=SOFT)
    lx += 19 + d.textlength(label, font=font(11))/S + 24

COL_Y = 556
COL_W = 380
COLS = [
    dict(x=40,  n="1", title="轻量增强：只加不减", v="代价小 · 风险低 · 建议先做", vf=ADD_F, vl=ADD_L, mode="light"),
    dict(x=460, n="2", title="影子整块替换",     v="代价大 · 风险高 · 要跟官方升级", vf=LOST_F, vl=LOST_L, mode="shadow"),
    dict(x=880, n="3", title="先做 PoC 验证",     v="半天到一天 · 只验证不交付", vf=WARN_F, vl=WARN_L, mode="poc"),
]

BULLETS = {
"light": [
 ("原理", "完全不碰 sidebar.workspaces。只在官方已经留好的加法位里塞东西：侧栏图标、会话行前后的装饰格、会话行悬停按钮、会话/工作区右键菜单加一项、侧栏底部按钮。"),
 ("要改多少", "workbench/client.js 里现有 4 处注册再加 2~3 处，百来行。不复制官方组件，官方升级时自动跟着变。"),
 ("代价", "改不了官方列表的分组/排序/外观，项目这个维度只能以「标记 + 额外入口」的形式存在，做不到「只剩项目视图」。"),
],
"shadow": [
 ("原理", "用 priority:-1 注册我们自己的浏览区组件，把 priority:0 的官方 WorkspaceBrowser 顶下去。这是官方自己也用的手法（liveshare 就用 -10 顶掉官方品牌位）。"),
 ("为什么贵", "要自己重画：分区标题、搜索（Host 搜索 + 去抖 + 分页）、分组/排序/归档筛选与持久化、拖拽排序、行与状态点、重命名/删除弹窗、宽/rail 两态。官方这块是 24 个文件、6010 行 TS + 1069 行 CSS。"),
 ("为什么危险", "影子注册不能再声明官方那 5 个子槽（会抛 already declared）；而组件又只能渲染自己声明过的子槽。结果：目录选择器、行尾归档/置顶按钮、schedule 和 liveshare 的行装饰，全部静默不再渲染，而且不报错。"),
],
"poc": [
 ("原理", "不改真插件。在隔离实例（.devhome，端口 52999）挂一个最小的 priority:-1 组件，只画「标题 + 几行假会话」，专门把上面那些推断变成实测。"),
 ("验证 4 件事", "一是子槽贡献是否真的静默消失；二是「添加工作区」的目录选择器是否失效；三是宽/rail 两态是否错位；四是首屏时间和包体积涨多少。"),
 ("产出", "一份实测结论，以及「值不值得走方案 2」的判断。不交付功能代码，验证完就删。"),
],
}

for col in COLS:
    x, mode = col["x"], col["mode"]
    ic_badge(x, COL_Y-3, col["n"], r=9)
    text(x+24, COL_Y-1, col["title"], size=16, bold=True)
    rect(x, COL_Y+26, COL_W-10, 22, fill=col["vf"], outline=col["vl"], radius=5)
    text(x+9, COL_Y+30, col["v"], size=11, color=(31, 41, 55))

    mx, my, mw, mh = x+30, COL_Y+58, 244, 258
    hy2 = sidebar_frame(mx, my, mw, mh, our_icon=(mode != "shadow"))[1]
    by = hy2 + 18

    if mode == "light":
        rect(mx+8, by, mw-16, 19, fill=OFF_F, outline=OFF_L, radius=5)
        ic_tri_down(mx+17, by+9.5)
        text(mx+26, by+1, "工作区 A", size=9)
        ic_kebab(mx+mw-18, by+9.5)
        for i, lbl in enumerate(["会话 1", "会话 2", "会话 3"]):
            ry = by+25 + i*19
            rect(mx+8, ry, mw-16, 17, fill=(246, 247, 249), radius=4)
            rect(mx+12, ry+4.5, 8, 8, fill=ADD_F, outline=ADD_L, radius=2)
            text(mx+25, ry+2, lbl, size=9, color=MUTED)
            rect(mx+mw-33, ry+4, 18, 10, fill=ADD_F, outline=ADD_L, radius=3)
        ry = by+84
        rect(mx+8, ry, mw-16, 17, fill=(246, 247, 249), radius=4)
        rect(mx+12, ry+4.5, 8, 8, fill=ADD_F, outline=ADD_L, radius=2)
        text(mx+25, ry+2, "项目阶段徽章", size=9, color=SOFT)
        ry = by+106
        rect(mx+8, ry, mw-16, 17, fill=(246, 247, 249), radius=4)
        rect(mx+12, ry+4.5, 8, 8, fill=ADD_F, outline=ADD_L, radius=2)
        text(mx+25, ry+2, "切片标记", size=9, color=SOFT)
        fy = my+mh-27
        line(mx+8, fy-7, mx+mw-8, fy-7)
        ic_gear(mx+19, fy+4)
        text(mx+28, fy-1, "设置", size=9, color=MUTED)
        for i in range(2):
            rect(mx+mw-44+i*20, fy-2, 16, 14, fill=ADD_F, outline=ADD_L, radius=4)

    if mode == "shadow":
        rect(mx+8, by, mw-16, 104, fill=OUR_F, outline=OUR_L, width=2, radius=6)
        text(mx+14, by+6, "我们的浏览器组件", size=10, bold=True, color=(30, 64, 175))
        for i, t2 in enumerate(["自画：标题 / 搜索 / 分组", "自画：拖拽排序 / 状态点",
                                "自画：重命名 / 删除弹窗", "自画：宽 ↔ rail 两种布局"]):
            text(mx+14, by+25+i*15, t2, size=9, color=(30, 64, 175))
        rect(mx+14, by+83, mw-44, 14, fill=(254, 226, 226), radius=3)
        text(mx+18, by+84, "priority: -1 顶掉官方", size=9, bold=True, color=(185, 28, 28))
        for i, lbl in enumerate(["目录选择器（添加工作区）", "行尾归档 / 置顶按钮", "schedule / liveshare 行装饰"]):
            ry = by+112 + i*19
            rect(mx+8, ry, mw-16, 17, fill=LOST_F, outline=LOST_L, radius=4)
            ic_cross(mx+16, ry+8.5, s=2.8)
            text(mx+24, ry+2, lbl, size=9, color=(153, 27, 27))
        text(mx+8, by+172, "静默消失，且不报错", size=9, color=(153, 27, 27))

    if mode == "poc":
        rect(mx+8, by, mw-16, 62, fill=OUR_F, outline=OUR_L, width=2, radius=6)
        text(mx+14, by+6, "只画两样东西", size=10, bold=True, color=(30, 64, 175))
        text(mx+14, by+24, "分区标题 + 几行假会话", size=9, color=(30, 64, 175))
        text(mx+14, by+40, "priority: -1（只为验证）", size=9, color=(30, 64, 175))
        for i, lbl in enumerate(["子槽是否真静默消失", "目录选择器是否失效",
                                 "宽 / rail 两态是否错位", "首屏时间、包体积涨多少"]):
            ry = by+70 + i*19
            rect(mx+8, ry, mw-16, 17, fill=WARN_F, outline=WARN_L, radius=4)
            text(mx+14, ry+2, "?", size=9, bold=True, color=(113, 63, 18))
            text(mx+25, ry+2, lbl, size=9, color=(113, 63, 18))
        text(mx+8, by+150, "隔离实例 .devhome · 端口 52999", size=9, color=MUTED)

    ty = COL_Y + 58 + 258 + 20
    for head, body in BULLETS[mode]:
        text(x, ty, head, size=12, bold=True)
        ty = para(x, ty+18, body, size=10.5, maxw=COL_W-16, lh=1.5) + 10

# ================================================================ recommendation
ry0 = 1156
rect(40, ry0, W-80, 66, fill=(240, 249, 255), outline=(125, 190, 240), radius=8)
ic_badge(58, ry0+11, 1, r=8, fill=(8, 145, 178))
text(76, ry0+8, "建议顺序：先 1，再 3，真有必要才上 2", size=14, bold=True, color=(12, 74, 110))
para(58, ry0+32,
     "先用方案 1 把「项目」这个维度加到官方列表旁边（不动官方、什么都不会丢）；看完如果还觉得必须整块换掉，再用方案 3 花半天实测清楚方案 2 到底会丢什么、值不值。",
     size=11, maxw=W-120, lh=1.45, color=(12, 74, 110))

out = os.path.join("docs", "diagrams", "sidebar-three-options.zh.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.resize((W, H), Image.LANCZOS).save(out, optimize=True)
print("saved", out, os.path.getsize(out))
