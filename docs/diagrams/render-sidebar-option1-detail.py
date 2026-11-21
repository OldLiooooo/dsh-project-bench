# -*- coding: utf-8 -*-
"""方案 ① 轻量增强 —— 「项目」维度怎么挂到官方左侧栏上（细节图 v2）。"""
import os
from PIL import Image, ImageDraw, ImageFont

S = 2
W, H = 1340, 986

BG=(255,255,255); INK=(17,24,39); SOFT=(55,65,81); MUTED=(107,114,128)
LINE=(209,213,219); PANEL=(250,250,251)
OFF_F=(233,236,239); OFF_L=(156,163,175)
OUR_F=(219,234,254); OUR_L=(59,130,246)
ADD_F=(220,252,231); ADD_L=(34,197,94)
LOST_F=(254,226,226); LOST_L=(239,68,68)
WARN_F=(254,249,195); WARN_L=(234,179,8)

F_REG="C:/Windows/Fonts/msyh.ttc"; F_BLD="C:/Windows/Fonts/msyhbd.ttc"
_c={}
def font(size,bold=False):
    k=(size,bold)
    if k not in _c: _c[k]=ImageFont.truetype(F_BLD if bold else F_REG, size*S, index=0)
    return _c[k]

img=Image.new("RGB",(W*S,H*S),BG); d=ImageDraw.Draw(img)

def rect(x,y,w,h,fill=None,outline=None,width=1,radius=6):
    d.rounded_rectangle([x*S,y*S,(x+w)*S,(y+h)*S], radius=radius*S, fill=fill,
                        outline=outline, width=int(round(max(1.0,width)*S)))

def text(x,y,s,size=13,bold=False,color=INK,anchor="la"):
    d.text((x*S,y*S),s,font=font(size,bold),fill=color,anchor=anchor)

def line(x1,y1,x2,y2,color=LINE,width=1):
    d.line([x1*S,y1*S,x2*S,y2*S],fill=color,width=int(round(max(1.0,width)*S)))

def wrap(s,size,maxw,bold=False):
    toks=[];buf=""
    def flush():
        nonlocal buf
        if buf: toks.append(buf); buf=""
    for ch in s:
        if ch=="\n": flush(); toks.append("\n")
        elif ord(ch)>0x2E80 or ch in "，。；：、「」（）—…·×→←↔“”": flush(); toks.append(ch)
        elif ch==" ": flush(); toks.append(" ")
        else: buf+=ch
    flush()
    f=font(size,bold); out=[];cur=""
    closing="。，、；：）」』】！？…%,.;:)"
    for tk in toks:
        if tk=="\n": out.append(cur); cur=""; continue
        if tk==" ":
            if cur: cur+=" "
            continue
        if f.getlength(cur+tk)/S>maxw and cur.strip() and tk not in closing:
            out.append(cur.rstrip()); cur=tk
        else: cur+=tk
    out.append(cur); return out

def para(x,y,s,size=11,maxw=330,lh=1.55,color=SOFT,bold=False):
    for ln in wrap(s,size,maxw,bold):
        text(x,y,ln,size=size,color=color,bold=bold); y+=size*lh
    return y

def badge(cx,cy,n,r=9,fill=(34,197,94),fg=(255,255,255)):
    d.ellipse([(cx-r)*S,(cy-r)*S,(cx+r)*S,(cy+r)*S],fill=fill)
    text(cx,cy-0.5,str(n),size=max(9,int(r*1.2)),bold=True,color=fg,anchor="mm")

def ic_tri_r(cx,cy,s=3.0,color=MUTED):
    d.polygon([((cx-s*0.5)*S,(cy-s)*S),((cx-s*0.5)*S,(cy+s)*S),((cx+s*0.9)*S,cy*S)],fill=color)
def ic_tri_d(cx,cy,s=3.0,color=MUTED):
    d.polygon([((cx-s)*S,(cy-s*0.5)*S),((cx+s)*S,(cy-s*0.5)*S),(cx*S,(cy+s*0.9)*S)],fill=color)
def ic_search(cx,cy,s=3.2,color=MUTED):
    d.ellipse([(cx-s)*S,(cy-s)*S,(cx+s*0.6)*S,(cy+s*0.6)*S],outline=color,width=int(round(1.2*S)))
    line(cx+s*0.5,cy+s*0.5,cx+s*1.5,cy+s*1.5,color,1.2)
def ic_sliders(cx,cy,ww=6.5,color=MUTED):
    for i,off in enumerate((-3.2,0,3.2)):
        line(cx-ww,cy+off,cx+ww,cy+off,color,1)
        px=cx+(2.2 if i==1 else -1.5)
        d.ellipse([(px-1.3)*S,(cy+off-1.3)*S,(px+1.3)*S,(cy+off+1.3)*S],fill=color)
def ic_kebab(cx,cy,color=MUTED):
    for off in (-3.0,0,3.0):
        d.ellipse([(cx-1.0)*S,(cy+off-1.0)*S,(cx+1.0)*S,(cy+off+1.0)*S],fill=color)
def ic_gear(cx,cy,r=3.2,color=MUTED):
    d.ellipse([(cx-r)*S,(cy-r)*S,(cx+r)*S,(cy+r)*S],outline=color,width=int(round(1.2*S)))
    d.ellipse([(cx-r*0.35)*S,(cy-r*0.35)*S,(cx+r*0.35)*S,(cy+r*0.35)*S],fill=color)
def ic_dot(cx,cy,r=1.6,color=MUTED):
    d.ellipse([(cx-r)*S,(cy-r)*S,(cx+r)*S,(cy+r)*S],fill=color)
def ic_alpha(cx,cy,ch,r=5.2,fill=ADD_F,line_c=ADD_L,color=(21,128,61)):
    d.ellipse([(cx-r)*S,(cy-r)*S,(cx+r)*S,(cy+r)*S],fill=fill,outline=line_c,width=int(round(1.0*S)))
    text(cx,cy-0.5,ch,size=8,bold=True,color=color,anchor="mm")

# =============================================================== 标题
text(40,24,"方案 ①：只加不减 —— 把「项目」这个维度挂到官方左侧栏上",size=25,bold=True)
text(40,62,"左边是改造后的侧栏：灰色元素一个都没动，绿色全是新加的东西。编号 1~7 对应右上方的 7 个落点，每个落点都是官方留好的 slot。",
     size=11.5,color=MUTED)

# =============================================================== 侧栏 mock
SX, SY, SW, SH = 40, 104, 250, 520
rect(SX,SY,SW,SH,fill=PANEL,outline=LINE,radius=8)
rect(SX+1,SY+1,SW-2,26,fill=(243,244,246),radius=8)
text(SX+11,SY+7,"DeepSeek",size=9,color=MUTED)

iy=SY+36+9
for i in range(3):
    cx=SX+22+i*26
    on=(i==1)
    rect(cx-9,iy-9,18,18,fill=OUR_F if on else (236,239,242),
         outline=OUR_L if on else (215,219,224),radius=4)
    if on: rect(cx-3.5,iy-3.5,7,7,fill=(37,99,235),radius=1)
ICON_MARK=iy

hy=SY+66
text(SX+11,hy-2,"工作区",size=10,bold=True)
ic_search(SX+SW-42,hy+5); ic_sliders(SX+SW-18,hy+5)

ay=hy+18
rect(SX+8,ay,SW-16,21,fill=OFF_F,outline=OFF_L,radius=5)
ic_tri_d(SX+17,ay+10.5); text(SX+26,ay+2,"工作区 A",size=9); ic_kebab(SX+SW-18,ay+10.5)

rows=[]
for i in range(4):
    ry=ay+27+i*24
    rows.append(ry)
    rect(SX+8,ry,SW-16,20,fill=(246,247,249),radius=4)

ic_alpha(SX+19,rows[0]+10,"产")
text(SX+30,rows[0]+3,"会话 1",size=9,color=MUTED)
LEAD_MARK=rows[0]+10

text(SX+18,rows[1]+3,"会话 2",size=9,color=MUTED)
rect(SX+SW-40,rows[1]+5,11,11,fill=ADD_F,outline=ADD_L,radius=2)
TRAIL_MARK=rows[1]+10

text(SX+18,rows[2]+3,"会话 3",size=9,color=MUTED)
rect(SX+SW-48,rows[2]+5,16,11,fill=ADD_F,outline=ADD_L,radius=3)
rect(SX+SW-29,rows[2]+5,16,11,fill=ADD_F,outline=ADD_L,radius=3)
ACTION_MARK=rows[2]+10

text(SX+18,rows[3]+3,"会话 4",size=9,color=MUTED)
ic_kebab(SX+SW-18,rows[3]+10)
MENU_MARK=rows[3]+10

by=rows[3]+30
rect(SX+8,by,SW-16,19,fill=(246,247,249),radius=4)
ic_tri_r(SX+17,by+9.5); text(SX+26,by+2,"工作区 B",size=9,color=MUTED)

# 悬停卡（放在工作区 B 下方，不压底部）
HX,HY = SX+30, by+26
HW,HH = SW-46, 66
rect(HX,HY,HW,HH,fill=(255,255,255),outline=ADD_L,width=1.4,radius=6)
text(HX+8,HY+5,"会话 2 · 所属项目",size=8.5,bold=True,color=(21,128,61))
for i,(k,v) in enumerate([("项目","支付重构"),("阶段","S2 架构"),("切片","refund"),("待决策","3 项")]):
    col=i%2; rowi=i//2
    text(HX+8+col*(HW/2-2),HY+24+rowi*17,f"{k}  {v}",size=8,color=SOFT)
HOVER_MARK=HY+HH/2

# 底部状态条
fy=SY+SH-32
line(SX+8,fy-9,SX+SW-8,fy-9)
rect(SX+8,fy-3,SW-50,21,fill=ADD_F,outline=ADD_L,radius=4)
ic_dot(SX+16,fy+8,r=2.6,color=ADD_L)
text(SX+23,fy+2,"支付重构 · S2 · 待决策 3",size=8.5,color=(21,128,61))
ic_gear(SX+SW-28,fy+8)
FOOT_MARK=fy+8

BX=SX+SW+18
for my,n in [(ICON_MARK,1),(FOOT_MARK,2),(LEAD_MARK,3),(TRAIL_MARK,4),
             (HOVER_MARK,5),(ACTION_MARK,6),(MENU_MARK,7)]:
    line(SX+SW+2,my,BX-11,my,ADD_L,1)
    badge(BX,my,n,r=8.5)


# =============================================================== 7 个落点
CARDS=[
 (1,"侧栏图标（现在就有，不改）","sidebar.panellist · list",
  "「项目工作台」图标 → 打开我们自己的项目面板（main keyed panel，已有）。",
  "限制：owner props 只有 size / active，图标上挂不了角标。", OUR_F, OUR_L),
 (2,"侧栏底部状态条（新）","sidebar.footer.action · list",
  "「支付重构 · S2 · 待决策 3」按钮，点开面板并定位到项目。",
  "限制：侧栏折叠成 56px rail 时只显示图标（props 里有 wide 可判断）。", ADD_F, ADD_L),
 (3,"会话行前格（新）","sidebar.session.row.leading · list",
  "角色首字徽章：产 / 架 / 码 / 测，一眼看出这条会话是谁在干。",
  "限制：该行有状态点时整格被状态点顶掉；归档行也留空。", ADD_F, ADD_L),
 (4,"会话行行尾（新）","sidebar.session.row.trailing · list",
  "项目专属小图标（只放非交互图标，这里不能放按钮）。",
  "限制：鼠标悬停在该行时隐藏；空白会话不渲染。", ADD_F, ADD_L),
 (5,"会话行悬停卡（新）","sidebar.session.row.hover · list",
  "项目 / 阶段 / 切片 / 角色 / 待决策数，鼠标停一下全看到。",
  "限制：只在悬停卡打开时挂载，拿不到鼠标坐标。", ADD_F, ADD_L),
 (6,"会话行悬停按钮（新）","sidebar.workspaces.session.row.action · list",
  "「在项目中定位此切片」按钮 → 打开面板并跳到那个切片。",
  "限制：只能加按钮，官方归档 / 置顶还在，靠 order 排先后。", ADD_F, ADD_L),
 (7,"「…」菜单里加两项（新）","sidebar.workspaces.session.menu.item · list",
  "「打开所属项目」「复制切片 ID」。",
  "限制：只能加，删不掉官方那 5 项。", ADD_F, ADD_L),
]

CARD_W = 452
CX_L = 356
CX_R = 828
CARD_GAP = 9

def draw_card(card, x, y, cw):
    n,head,slot,body,limit,fill,outl = card
    body_w = cw-26
    b_lines = wrap(body, 10, body_w)
    l_lines = wrap(limit, 9.5, body_w-4)
    hh = 10 + 15 + 13 + 6 + len(b_lines)*15 + 4 + len(l_lines)*14 + 10
    rect(x,y,cw,hh,fill=fill,outline=outl,radius=7)
    badge(x+18,y+16,n,r=9,fill=outl)
    text(x+32,y+7,head,size=12,bold=True)
    text(x+32,y+25,slot,size=9.5,color=(21,128,61) if fill is ADD_F else (30,64,175))
    ty=y+42
    ty=para(x+13,ty,body,size=10,maxw=body_w,lh=1.5,color=SOFT)
    ty+=3
    para(x+13,ty,limit,size=9.5,maxw=body_w-4,lh=1.45,color=(120,113,108))
    return hh

CY=104
y=CY
for c in CARDS[:4]:
    y += draw_card(c, CX_L, y, CARD_W) + CARD_GAP
left_end=y

y=CY
for c in CARDS[4:]:
    y += draw_card(c, CX_R, y, CARD_W) + CARD_GAP
right_end=y

# 「还能加」补充框，接在右列后面
EX_H = 112
rect(CX_R, right_end+2, CARD_W, EX_H, fill=(248,250,252), outline=LINE, radius=7)
text(CX_R+14, right_end+11, "还能加（可选，不在 7 个之内）", size=11, bold=True)
yy=right_end+31
for o in ["sidebar.toggle.badge —— 侧栏折叠时，在展开按钮里显示待决策数",
          "ctx.contextMenus.register({ target:'workspace' }) —— 工作区行加一项「打开项目工作台」",
          "sidebar.panellist.actions —— 面板「更多」菜单里加一行"]:
    ic_dot(CX_R+18,yy+5,r=1.8,color=ADD_L)
    yy = para(CX_R+27,yy,o,size=9.5,maxw=CARD_W-44,lh=1.45,color=SOFT)+2

# =============================================================== 数据链路
ROW_TOP = max(left_end, right_end+EX_H+8) + 26
text(40, ROW_TOP, "数据从哪来：只多一张查表，官方列表一行都不改", size=14, bold=True)

boxes=[
 (".project/project.db","唯一事实源：项目 / 阶段 / 切片 / 会话 / 决策", OFF_F, OFF_L),
 ("Host 插件 API","GET /project-workbench/api/snapshot", OUR_F, OUR_L),
 ("Client hub（已有）","缓存快照 + 建索引", OUR_F, OUR_L),
 ("新：sessionId 查表","dshSessionId → 项目 / 阶段 / 切片 / 角色", ADD_F, ADD_L),
 ("新：7 个 slot 组件","只拿 sessionId 查表，渲染小徽章", ADD_F, ADD_L),
]
bw, gap = 236, 18
bx = 40
by2 = ROW_TOP + 28
for i,(h1,h2,fill,outl) in enumerate(boxes):
    x=bx+i*(bw+gap)
    rect(x,by2,bw,56,fill=fill,outline=outl,radius=6)
    text(x+10,by2+8,h1,size=10.5,bold=True)
    para(x+10,by2+26,h2,size=9,maxw=bw-20,lh=1.4,color=SOFT)
    if i < len(boxes)-1:
        ax1=x+bw+2; ax2=x+bw+gap-4; acy=by2+28
        line(ax1,acy,ax2,acy,MUTED,1.2)
        d.polygon([(ax2*S,(acy-3.2)*S),((ax2+5)*S,acy*S),(ax2*S,(acy+3.2)*S)],fill=MUTED)

# =============================================================== 边界
LIM_TOP = by2 + 56 + 30
text(40, LIM_TOP, "讲清楚边界：方案 ① 做不到什么（这些只有方案 ② 才有）", size=14, bold=True)

limits=[
 ("改不了官方列表的分组 / 排序 / 筛选", "那个滑杆「视图选项」下拉（分组方式、排序方式、隐藏归档）写在组件里，没有任何 slot。"),
 ("做不到「只剩项目视图」", "官方会话列表永远在那儿。要把它整块换掉，只能影子替换，那就是方案 ②。"),
 ("替换不掉工作区行的「重命名 / 删除」", "0.2.2 的右键菜单注册表按 target + id 去重，同 id 注册直接抛 Duplicate menu contribution。"),
 ("图标上挂不了角标", "sidebar.panellist 的 owner props 只有 size / active，所以待决策数放在底部状态条和折叠角标上。"),
]
yy = LIM_TOP + 26
for h1,h2 in limits:
    hh = 40
    rect(40, yy, W-80, hh, fill=LOST_F, outline=LOST_L, radius=6)
    text(54, yy+11, "✕", size=12, bold=True, color=LOST_L)
    text(74, yy+11, h1, size=11, bold=True, color=(153,27,27))
    text(74 + d.textlength(h1, font=font(11,True))/S + 16, yy+12, h2, size=9.5, color=(153,27,27))
    yy += hh + 6

# =============================================================== 结论
CON_TOP = yy + 20
rect(40, CON_TOP, W-80, 66, fill=(240,249,255), outline=(125,190,240), radius=8)
text(56, CON_TOP+9, "工作量估算：7 个落点都是「注册一个条目 + 一个小展示组件」，不复制官方任何代码",
     size=12.5, bold=True, color=(12,74,110))
para(56, CON_TOP+32,
     "每个落点 10~40 行，加一张查表和一个悬停卡，总量 400 行以内。这些 slot 全是加法位，官方升级时基本不会打架。",
     size=10.5, maxw=W-120, lh=1.45, color=(12,74,110))

out=os.path.join("docs","diagrams","sidebar-option1-detail.zh.png")
os.makedirs(os.path.dirname(out),exist_ok=True)
img.resize((W,H),Image.LANCZOS).save(out,optimize=True)
print("saved",out,os.path.getsize(out),"content bottom:",CON_TOP+66)
