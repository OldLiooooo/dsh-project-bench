# -*- coding: utf-8 -*-
"""DSH Web GUI 槽位标注图：这张界面上的每块区域到底是什么 slot。"""
import os
from PIL import Image, ImageDraw, ImageFont

S = 2
W, H = 1760, 1650

BG=(255,255,255); INK=(15,23,42); SOFT=(51,65,85); MUTED=(100,116,139)
LINE=(226,232,240); ACCENT=(65,118,230)
F_REG="C:/Windows/Fonts/msyh.ttc"; F_BLD="C:/Windows/Fonts/msyhbd.ttc"; F_MONO="C:/Windows/Fonts/consola.ttf"
_c={}
def font(size,bold=False,mono=False):
    k=(size,bold,mono)
    if k not in _c:
        if mono: _c[k]=ImageFont.truetype(F_MONO, size*S)
        else: _c[k]=ImageFont.truetype(F_BLD if bold else F_REG, size*S, index=0)
    return _c[k]

img=Image.new("RGB",(W*S,H*S),BG); d=ImageDraw.Draw(img)

ADD_F=(220,252,231); ADD_L=(34,197,94); ADD_T=(21,128,61)
REP_F=(254,243,199); REP_L=(245,158,11); REP_T=(146,64,14)
BAN_F=(254,226,226); BAN_L=(239,68,68); BAN_T=(153,27,27)
CHN_F=(219,234,254); CHN_L=(59,130,246); CHN_T=(30,64,175)

def rect(x,y,w,h,fill=None,outline=None,width=1,radius=6):
    d.rounded_rectangle([x*S,y*S,(x+w)*S,(y+h)*S], radius=radius*S, fill=fill,
                        outline=outline, width=int(round(max(1.0,width)*S)))
def text(x,y,s,size=12,bold=False,color=INK,anchor="la",mono=False):
    d.text((x*S,y*S),s,font=font(size,bold,mono),fill=color,anchor=anchor)
def line(x1,y1,x2,y2,color=LINE,width=1):
    d.line([x1*S,y1*S,x2*S,y2*S],fill=color,width=int(round(max(1.0,width)*S)))
def wrap(s,size,maxw,bold=False,mono=False):
    f=font(size,bold,mono); out=[]; cur=""
    closing="。，、；：）」』】！？…%,.;:)"
    for ch in s:
        if ch=="\n": out.append(cur); cur=""; continue
        if f.getlength(cur+ch)/S>maxw and cur.strip() and ch not in closing:
            out.append(cur); cur=ch
        else: cur+=ch
    out.append(cur); return out
def para(x,y,s,size=11,maxw=300,lh=1.55,color=SOFT,bold=False,mono=False):
    for ln in wrap(s,size,maxw,bold,mono):
        text(x,y,ln,size=size,color=color,bold=bold,mono=mono); y+=size*lh
    return y
PIN_POS=[]
def pin(cx,cy,n,color):
    PIN_POS.append((cx,cy,n))
    r=11.5
    d.ellipse([(cx-r)*S,(cy-r)*S,(cx+r)*S,(cy+r)*S],fill=(255,255,255))
    d.ellipse([(cx-r)*S,(cy-r)*S,(cx+r)*S,(cy+r)*S],fill=color)
    d.ellipse([(cx-r)*S,(cy-r)*S,(cx+r)*S,(cy+r)*S],outline=(255,255,255),width=int(1.6*S))
    text(cx,cy-0.4,str(n),size=11,bold=True,color=(255,255,255),anchor="mm")

# ================= 标题
text(48,26,"这张界面上，每一块到底是什么 slot",size=25,bold=True)
text(48,66,"把 DSH Web GUI 按真实槽位拆开：左边是界面（数字＝插槽），右边是每个插槽的 key、类型和能不能动。",size=11.5,color=SOFT)
# 图例
lx=48; ly=92
for (tf,tl,tt,lab) in [(ADD_F,ADD_L,ADD_T,"加法：注册一条，和官方并存"),
                       (CHN_F,CHN_L,CHN_T,"接管：临时顶上，可回退"),
                       (REP_F,REP_L,REP_T,"替换：同格换人，只影响这一格"),
                       (BAN_F,BAN_L,BAN_T,"别碰：整块抢走会丢官方能力")]:
    d.rounded_rectangle([lx*S,(ly-1)*S,(lx+9)*S,(ly+8)*S],radius=2*S,fill=tf,outline=tl,width=int(1.1*S))
    text(lx+15,ly-1,lab,size=9.8,color=tt)
    lx+=15+font(9.8).getlength(lab)/S+22
# 蓝环图例（接在四个色块后面）
d.ellipse([(lx+1)*S,(ly-1)*S,(lx+10)*S,(ly+8)*S],outline=(59,130,246),width=int(2.2*S))
text(lx+15,ly-1,"蓝环：你的「项目工作台」已经占的座位（另有 1 处占的是整块主面板 main）",size=9.8,bold=True,color=(30,64,175))
text(48,112,"数据来源：本机 0.2.2-rc.1 的实时 slot catalog（97 个 key），不是通用示意。",size=9.5,color=MUTED)

# ================= 主窗口
WX,WY,WW,WH = 48,134,900,832
d.rounded_rectangle([WX*S,WY*S,(WX+WW)*S,(WY+WH)*S],radius=10*S,fill=(255,255,255),outline=(203,213,225),width=int(1.6*S))
d.rounded_rectangle([WX*S,WY*S,(WX+240)*S,(WY+WH)*S],radius=10*S,fill=(250,250,251))
d.rectangle([(WX+228)*S,WY*S,(WX+240)*S,(WY+WH)*S],fill=(250,250,251))
line(WX+240,WY,WX+240,WY+WH,(226,232,240),1.4)

fx,fy=WX+26,WY+28
d.ellipse([(fx-11)*S,(fy-8)*S,(fx+7)*S,(fy+8)*S],fill=ACCENT)
d.polygon([((fx+6)*S,(fy-7)*S),((fx+15)*S,(fy-11)*S),((fx+15)*S,(fy+11)*S),((fx+6)*S,(fy+7)*S)],fill=ACCENT)
text(fx+24,fy-7,"DeepSeek Harness",size=12.5,bold=True)
line(WX+214,WY+20,WX+214,WY+36,(148,163,184),1.4); line(WX+220,WY+20,WX+220,WY+36,(148,163,184),1.4)

rect(WX+12,WY+54,216,28,fill=(255,255,255),outline=(226,232,240),radius=7)
d.ellipse([(WX+24)*S,(WY+64)*S,(WX+32)*S,(WY+72)*S],outline=(148,163,184),width=int(1.3*S))
line(WX+31.5,WY+71.5,WX+35,WY+75,(148,163,184),1.3)
text(WX+44,WY+61,"搜索会话",size=11,color=(148,163,184))

rect(WX+12,WY+92,216,30,fill=(255,255,255),outline=(226,232,240),radius=7)
text(WX+26,WY+99,"工作区 A",size=11.5,bold=True)
text(WX+206,WY+100,"⌄",size=12,color=MUTED)

rows=[("产品 · refund-PRD",True,True),("码农 · refund-API",False,True),("PM（项目办公室）",False,False),("测试 · refund-e2e",False,False)]
ry=WY+130
for i,(name,sel,dot) in enumerate(rows):
    if sel: rect(WX+8,ry,224,30,fill=(233,240,254),radius=6)
    if dot: d.ellipse([(WX+20)*S,(ry+12)*S,(WX+27)*S,(ry+19)*S],fill=(34,197,94) if i==0 else (148,163,184))
    text(WX+34,ry+8,name,size=11.2,color=INK if sel else SOFT)
    for off in (-4,0,4):
        d.ellipse([(WX+207)*S,(ry+15+off-1.2)*S,(WX+209.4)*S,(ry+15+off+1.2)*S],fill=(148,163,184))
    ry+=32
text(WX+34,ry+8,"⌄  工作区 B",size=11,bold=True,color=SOFT)

py_=WY+682
for i in range(3):
    bx=WX+14+i*34
    rect(bx,py_,26,26,fill=(255,255,255),outline=(203,213,225),radius=6)
    line(bx+8,py_+13,bx+18,py_+13,(100,116,139),1.6); line(bx+13,py_+8,bx+13,py_+18,(100,116,139),1.6)

# 设置齿轮（sidebar.settings）
gy=WY+714
rect(WX+12,gy,216,26,fill=(255,255,255),outline=(226,232,240),radius=6)
d.ellipse([(WX+24)*S,(gy+8)*S,(WX+34)*S,(gy+18)*S],outline=(100,116,139),width=int(1.3*S))
d.ellipse([(WX+27.4)*S,(gy+11.4)*S,(WX+30.6)*S,(gy+14.6)*S],fill=(100,116,139))
text(WX+42,gy+6,"设置",size=10.5,color=SOFT)

rect(WX+12,WY+748,216,34,fill=(255,255,255),outline=(226,232,240),radius=8)
d.ellipse([(WX+24)*S,(WY+753)*S,(WX+32)*S,(WY+761)*S],fill=(34,197,94))
text(WX+40,WY+748,"支付重构 · S2 · 待决策 3",size=10.8,color=SOFT)
d.ellipse([(WX+196)*S,(WY+751)*S,(WX+204)*S,(WY+759)*S],outline=(100,116,139),width=int(1.2*S))
d.ellipse([(WX+198.6)*S,(WY+753.6)*S,(WX+201.4)*S,(WY+756.4)*S],fill=(100,116,139))

# --- 会话头
CX=WX+240
text(CX+24,WY+18,"UI强化插件的实现方式",size=13.5,bold=True)
text(CX+24,WY+40,"从「新建会话」续",size=10,color=(148,163,184))
for ic_x in (CX+556,CX+586,CX+616):
    rect(ic_x,WY+22,22,22,fill=(255,255,255),outline=(226,232,240),radius=5)
    line(ic_x+7,WY+33,ic_x+15,WY+33,(100,116,139),1.4); line(ic_x+11,WY+29,ic_x+11,WY+37,(100,116,139),1.4)
for off in (-4,0,4):
    d.ellipse([(CX+642)*S,(WY+33+off-1.3)*S,(CX+644.6)*S,(WY+33+off+1.3)*S],fill=(100,116,139))

line(CX,WY+66,CX+660,WY+66,(226,232,240),1.2)
text(CX+24,WY+74,"对话",size=11.5,bold=True,color=ACCENT)
line(CX+24,WY+94,CX+56,WY+94,ACCENT,2.2)
text(CX+80,WY+75,"轨迹",size=11.5,color=(100,116,139))
text(CX+124,WY+75,"统计",size=11.5,color=(100,116,139))

rect(CX+392,WY+116,244,50,fill=(233,240,254),radius=12)
text(CX+406,WY+128,"UI 强化插件都是怎么做的？",size=11,color=(30,64,175))
text(CX+24,WY+192,"◈  思考了 2 秒",size=10,color=(148,163,184))
for i in range(3):
    rect(CX+24,WY+212+i*13,300-i*40,7,fill=(241,245,249),radius=3)
rect(CX+24,WY+260,420,7,fill=(241,245,249),radius=3)
rect(CX+24,WY+274,380,7,fill=(241,245,249),radius=3)
rect(CX+24,WY+300,586,36,fill=(250,250,251),outline=(226,232,240),radius=8)
text(CX+38,WY+312,"▸  run_code",size=10.5,mono=True,color=(51,65,85))
text(CX+150,WY+312,"count slots in catalog",size=10,color=(148,163,184))
rect(CX+556,WY+308,42,20,fill=(220,252,231),radius=5)
text(CX+577,WY+312,"完成",size=9.5,color=(21,128,61),anchor="ma")
for i,wdt in enumerate([520,470,540,300]):
    rect(CX+24,WY+352+i*14,wdt,7,fill=(241,245,249),radius=3)
for i in range(4):
    bx=CX+24+i*26
    rect(bx,WY+426,18,18,fill=(255,255,255),outline=(226,232,240),radius=4)
    line(bx+6,WY+435,bx+12,WY+435,(148,163,184),1.2)

rect(CX+296,WY+460,294,56,fill=(255,255,255),outline=(203,213,225),radius=9)
text(CX+312,WY+470,"● 后台任务 · 2 个运行中",size=10.5,bold=True,color=(30,64,175))
text(CX+312,WY+490,"浮在整个界面之上，默认点击穿透",size=9.5,color=MUTED)

rect(CX+16,WY+574,586,26,fill=(243,244,246),outline=(226,232,240),radius=7)
text(CX+30,WY+580,"＋  PM 摘要 · 待决策 3   （插件挂在输入框上方的常驻条）",size=10,color=(71,85,105))

rect(CX+16,WY+608,586,146,fill=(255,255,255),outline=(203,213,225),radius=11)
rect(CX+28,WY+620,86,20,fill=(233,240,254),radius=5)
text(CX+36,WY+623,"refund-PRD.md",size=9,color=(30,64,175))
text(CX+28,WY+656,"输入消息…",size=11,color=(148,163,184))
rect(CX+28,WY+706,74,22,fill=(243,244,246),radius=6); text(CX+38,WY+711,"默认权限",size=9.5,color=(71,85,105))
rect(CX+108,WY+706,54,22,fill=(243,244,246),radius=6); text(CX+118,WY+711,"计划",size=9.5,color=(71,85,105))
rect(CX+168,WY+706,104,22,fill=(243,244,246),radius=6); text(CX+178,WY+711,"DeepSeek V3",size=9.5,color=(71,85,105))
rect(CX+474,WY+706,22,22,fill=(255,255,255),outline=(226,232,240),radius=5)
rect(CX+500,WY+706,22,22,fill=(255,255,255),outline=(226,232,240),radius=5)
d.ellipse([(CX+530)*S,(WY+704)*S,(CX+560)*S,(WY+734)*S],fill=ACCENT)
text(CX+545,WY+719,"↑",size=12,bold=True,color=(255,255,255),anchor="mm")

# ================= 高亮
ov=Image.new("RGBA",img.size,(0,0,0,0)); od=ImageDraw.Draw(ov)
def hl(x,y,w,h,fill):
    od.rounded_rectangle([x*S,y*S,(x+w)*S,(y+h)*S],radius=6*S,fill=fill)
hl(WX+12,WY+16,224,32,(245,158,11,42))
hl(WX+10,WY+90,220,34,(239,68,68,34))
hl(WX+8,WY+128,228,34,(34,197,94,34))
hl(WX+8,WY+160,228,34,(34,197,94,28))
hl(WX+10,WY+676,124,38,(34,197,94,38))
hl(WX+10,WY+708,220,32,(245,158,11,38))
hl(WX+10,WY+744,222,42,(34,197,94,38))
hl(WX+248,WY+14,660,48,(34,197,94,26))
hl(WX+248,WY+70,660,32,(34,197,94,34))
hl(CX+20,WY+296,594,44,(245,158,11,40))
hl(CX+12,WY+570,594,34,(34,197,94,38))
hl(CX+12,WY+604,594,154,(59,130,246,28))
hl(CX+292,WY+456,304,64,(34,197,94,34))
img=Image.alpha_composite(img.convert("RGBA"),ov).convert("RGB"); d=ImageDraw.Draw(img)

# ================= 编号
pin(WX+230,WY+22,1,REP_L)
pin(WX+232,WY+106,2,BAN_L)
pin(WX+226,WY+140,3,ADD_L)
pin(WX+226,WY+172,4,ADD_L)
pin(WX+232,WY+690,5,ADD_L)
pin(WX+234,WY+714,7,REP_L)
pin(WX+238,WY+758,6,ADD_L)
pin(CX+662,WY+22,8,ADD_L)
pin(CX+6,WY+82,9,ADD_L)
pin(CX+6,WY+310,10,REP_L)
pin(CX+6,WY+582,11,ADD_L)
pin(CX+6,WY+616,12,CHN_L)
pin(CX+300,WY+460,13,ADD_L)

# 工作台插件已经用到的座位：外圈加一圈蓝环
WB={3,4,5,6,8,11}
for (px_,py_,pn) in PIN_POS:
    if pn in WB:
        rr=15.5
        d.ellipse([(px_-rr)*S,(py_-rr)*S,(px_+rr)*S,(py_+rr)*S],outline=(59,130,246),width=int(2.2*S))

# ================= 设置弹窗
SX,SY,SW,SH=48,1010,560,404
d.rounded_rectangle([SX*S,SY*S,(SX+SW)*S,(SY+SH)*S],radius=12*S,fill=(255,255,255),outline=(203,213,225),width=int(1.6*S))
line(SX,SY+44,SX+SW,SY+44,(226,232,240),1.2)
text(SX+20,SY+14,"设置",size=13,bold=True)
text(SX+SW-34,SY+12,"×",size=15,color=MUTED)
line(SX+150,SY+44,SX+150,SY+SH,(226,232,240),1.2)
rect(SX+8,SY+152,134,30,fill=(220,252,231),radius=6)
text(SX+18,SY+160,"界面调整",size=11,bold=True,color=ADD_T)
for nm,ny in [("通用",SY+70),("模型",SY+106),("插件",SY+132)]:
    text(SX+18,ny,nm,size=11,color=SOFT)

text(SX+166,SY+60,"通用",size=12,bold=True)
for nm,ry2 in [("外观",SY+96),("字体大小",SY+128)]:
    text(SX+166,ry2,nm,size=10.8,color=SOFT)
    rect(SX+300,ry2-3,86,20,fill=(243,244,246),radius=5)
    text(SX+308,ry2+1,"800 × 800",size=9,color=(100,116,139))
rect(SX+160,SY+156,384,36,fill=(220,252,231),radius=7)
text(SX+168,SY+164,"设置弹框尺寸",size=10.8,color=ADD_T)
rect(SX+318,SY+161,132,24,fill=(255,255,255),outline=ADD_L,radius=5)
text(SX+326,SY+166,"1080 × 900",size=9,color=ADD_T)
text(SX+16,SY+330,"设置弹窗写死 800×800：没有槽位、没有 CSS 变量、也没走 token。",size=10,color=SOFT)
text(SX+16,SY+348,"所以「调大设置窗」这类插件只能用 <style> 改几何 —— 没有座位时的",size=10,color=SOFT)
text(SX+16,SY+366,"最后手段。",size=10,color=SOFT)
pin(SX+146,SY+167,14,ADD_L)
pin(SX+310,SY+167,15,ADD_L)

# ================= 右下角：三种操作的区别
BX,BY=640,1010; BW=328; BH=404
d.rounded_rectangle([BX*S,BY*S,(BX+BW)*S,(BY+BH)*S],radius=12*S,fill=(250,250,251),outline=(226,232,240),width=int(1.3*S))
text(BX+18,BY+16,"「加一个」和「换掉一个」的区别",size=12.5,bold=True)
steps=[
  ("加法  list → 注册新 id",ADD_L,ADD_T,"像往列表里 push 一条。官方条目还在，你的排在旁边，order 决定先后。"),
  ("替换  single → priority 更小",REP_L,REP_T,"同一格里谁 priority 小谁渲染。同 priority 再注册会直接抛错，所以只能「影子覆盖」。"),
  ("接管  chain → select() 返回非 null",CHN_L,CHN_T,"按 priority 轮流问「你接吗」，第一个返回结果的当选；全拒就回落到官方。"),
]
sy=BY+50
for (t,c,ct,desc) in steps:
    d.rounded_rectangle([(BX+18)*S,(sy+2)*S,(BX+26)*S,(sy+12)*S],radius=3*S,fill=c)
    text(BX+34,sy,t,size=10.6,bold=True,color=ct)
    sy=para(BX+18,sy+16,desc,size=9.6,maxw=BW-36,lh=1.5,color=SOFT)+12
text(BX+18,BY+372,"优先级数值：小 = 先渲染 / 先被问。",size=9.2,color=MUTED)

# ================= 右侧卡片
CARDS=[
 (1,"侧栏品牌位","sidebar.brand.mark / sidebar.brand.name","single · root","替换",REP_F,REP_L,REP_T,
  "官方占 priority 0。换 logo / 字标就是注册更小的 priority（liveshare 用 -10，dsh-brand 用 -100）。只换这两格，旁边的折叠、搜索、会话树全在。"),
 (2,"整个会话树","sidebar.workspaces","single · root","别碰",BAN_F,BAN_L,BAN_T,
  "ui-workspace 占着它，里面还声明了行首/行尾/悬停/行操作/菜单 5 个子槽。顶掉它 ＝ 会话列表、分组、搜索、归档一起消失，得自己重写。"),
 (3,"会话行三格","sidebar.session.row.leading / .hover / .trailing","list · root","加法",ADD_F,ADD_L,ADD_T,
  "行首 16px 小格、悬停卡片、行尾标记。加角色徽章、切片角标走这里。行尾官方规定只放图标，不能放按钮。"),
 (4,"行操作 + 菜单","sidebar.workspaces.session.row.action / .menu.item","list · root","加法",ADD_F,ADD_L,ADD_T,
  "每行悬停出现的按钮，和「…」菜单里的条目。菜单要求「一个条目 = 一个 role=menuitem 的按钮」，所以拆成多条注册。"),
 (5,"侧栏图标入口","sidebar.panellist","list · root","加法",ADD_F,ADD_L,ADD_T,
  "侧栏底部图标按钮行，每项给自增 id + 图标 + 标题。工作台「项目」面板入口就挂这。"),
 (6,"侧栏底栏","sidebar.footer.action","list · root","加法",ADD_F,ADD_L,ADD_T,
  "侧栏最底一行，适合状态胶囊。折叠成窄条时只剩图标，组件读 owner props 里的 wide 自己判断。"),
 (7,"设置齿轮","sidebar.settings","single · root","替换",REP_F,REP_L,REP_T,
  "官方设置入口。可以换但通常没必要；要加设置项请去 settings.section，别抢这个齿轮。"),
 (8,"会话头右上角","conversation.session.header.actions / .utilities / .views.actions","list · session","加法",ADD_F,ADD_L,ADD_T,
  "三排队列：主操作、工具（后台任务列表就挂这）、视图「更多」菜单。加按钮＝注册一条 id，不碰别人。"),
 (9,"视图标签","conversation.view","list · session","加法",ADD_F,ADD_L,ADD_T,
  "「对话 / 轨迹 / …」那排。第三方 View 在这注册（官方实验包「统计」页签同款）。"),
 (10,"消息节点","conversation.chat.node","keyed · session","替换",REP_F,REP_L,REP_T,
  "按 node 类型分派：user / assistant-step / tool-call / turn-tail。想改某一类消息长什么样，就是复用它的 key —— 这一格是「替换」语义。"),
 (11,"输入框上方条","conversation.composer.dock / .input.left / .input.right","list · session","加法",ADD_F,ADD_L,ADD_T,
  "dock 是输入框上方常驻条，left/right 是输入区两侧按钮组。工作台的 PM 摘要就在 dock 上。"),
 (12,"输入区接管","conversation.composer","chain · session","接管",CHN_F,CHN_L,CHN_T,
  "唯一实战的 chain 槽。审批卡、提问卡靠 select() 返回非 null 临时接管；原输入框不卸载（overlay），草稿不丢，回答完自动还回去。"),
 (13,"整页浮层","shell.overlay","list · root","加法",ADD_F,ADD_L,ADD_T,
  "盖在所有列之上，默认点击穿透，条目自己决定是否接收指针。toast、徽标、自定义检查器放这；别拿它做背景图（会盖住正文）。"),
 (14,"设置新页","settings.section","list · root","加法",ADD_F,ADD_L,ADD_T,
  "在设置左侧导航加一整页，自带图标和标题。复杂面板（主题编辑器、调参台）优先走这条。"),
 (15,"设置单行","settings.general.item","list · root","加法",ADD_F,ADD_L,ADD_T,
  "「通用」里的一行开关 / 滑块。只有一个开关就别占一整页 —— 大多数小插件这一条就够。"),
]
COLX=[1000,1364]; CW=340; CH_=168; GAP=10
counts={0:0,1:0}
for (n,title,key,scope,tag,tf,tl,tt,desc) in CARDS:
    col=0 if n<=7 else 1
    idx=counts[col]; counts[col]+=1
    x=COLX[col]; y=128+idx*(CH_+GAP)
    d.rounded_rectangle([x*S,y*S,(x+CW)*S,(y+CH_)*S],radius=9*S,fill=(255,255,255),outline=(226,232,240),width=int(1.3*S))
    d.rounded_rectangle([x*S,y*S,(x+4)*S,(y+CH_)*S],radius=2*S,fill=tl)
    pin(x+30,y+26,n,tl)
    text(x+50,y+14,title,size=12.5,bold=True)
    tw=font(9.5,True).getlength(tag)/S
    d.rounded_rectangle([(x+CW-18-tw-14)*S,(y+12)*S,(x+CW-12)*S,(y+32)*S],radius=5*S,fill=tf,outline=tl,width=int(1.0*S))
    text(x+CW-18-tw-7,y+16,tag,size=9.5,bold=True,color=tt)
    ky=y+42
    segs=key.split(" / ")
    lnbuf=""
    lines=[]
    for sg in segs:
        cand=(lnbuf+" / "+sg) if lnbuf else sg
        if font(9,mono=True).getlength(cand)/S>CW-28 and lnbuf:
            lines.append(lnbuf); lnbuf=sg
        else: lnbuf=cand
    if lnbuf: lines.append(lnbuf)
    for ln in lines[:2]:
        text(x+14,ky,ln,size=9,color=(71,85,105),mono=True); ky+=12
    text(x+14,ky+2,scope,size=8.5,color=(148,163,184)); ky+=16
    para(x+14,ky+2,desc,size=9.6,maxw=CW-28,lh=1.5,color=SOFT)

# ================= 底部红线
BY2=1560
d.rounded_rectangle([48*S,BY2*S,1704*S,(BY2+70)*S],radius=10*S,fill=(254,242,242))
text(66,BY2+10,"三条硬红线（踩了就白屏 / 崩）",size=11,bold=True,color=(153,27,27))
text(66,BY2+33,"① 不要注册 root —— 它是 single 槽，动态插件会被分配更小的 priority 直接赢，AppFrame 和它声明的所有座位一起没。",size=9.8,color=(127,29,29))
text(66,BY2+49,"② 不要往 document.body 塞节点 / 用 iframe 装官方页面 / 改 <html> 上宿主管的主题属性。  ③ 不要 import 官方 client 包（ui-primitives 等），要控件照样式自己写。",size=9.8,color=(127,29,29))

img=img.resize((W,H),Image.LANCZOS)
out=os.path.join(os.path.dirname(os.path.abspath(__file__)),"ui-slot-map.zh.png")
img.save(out,optimize=True)
print("saved",out,img.size)
