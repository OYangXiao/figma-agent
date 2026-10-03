#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
规格 → PNG 本地预览渲染器
=======================================================================
用 Pillow 复刻 plugin/code.js 的布局语义，使得「不改 Figma 也能看到画面」。

支持的语义（与插件保持一致）：
  FRAME  layout 'V'|'H' 自动布局 / 省略=绝对定位
         w,h  数字 | 'fill'（吃满父容器）| 'hug'（包裹内容）
         pad  数字 | [v,h] | [t,r,b,l]
         gap / main(MIN|CENTER|MAX|SPACE_BETWEEN) / cross(MIN|CENTER|MAX)
         wrap 换行 / fill / radius / stroke / opacity / clip
  TEXT   text/size/weight/color/align/valign/lineHeight，支持中英混排换行
  RECT/ELLIPSE  fill/radius/stroke/rotate（顺时针角度）

用法：python3 specs/preview.py [specs/stock-app.json]
产物：out/preview-<屏名>.png  和  out/contact-sheet.png
"""
import base64
import io
import json
import math
import os
import re
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "out")
os.makedirs(OUT, exist_ok=True)

# --------------------------------------------------------------------- 字体

FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_IDX_REGULAR = 0   # W3
FONT_IDX_BOLD = 2      # W6
_font_cache = {}


def get_font(size, weight=400):
    key = (round(size), weight)
    if key in _font_cache:
        return _font_cache[key]
    idx = FONT_IDX_BOLD if (weight or 400) >= 600 else FONT_IDX_REGULAR
    f = ImageFont.truetype(FONT_PATH, max(1, int(round(size))), index=idx)
    _font_cache[key] = f
    return f


# --------------------------------------------------------------------- 工具

def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def color(v):
    """'#RRGGBBAA' / '#RGB' → (r,g,b,a)"""
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip().lstrip("#")
        if len(s) == 3:
            s = "".join(c * 2 for c in s)
        if len(s) == 6:
            s += "FF"
        if len(s) != 8:
            return (0, 0, 0, 255)
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4, 6))
    return None


def pad_of(n):
    p = n.get("pad", n.get("padding"))
    if p is None:
        return (0, 0, 0, 0)
    if num(p):
        return (p, p, p, p)
    if isinstance(p, list):
        if len(p) == 2:
            return (p[0], p[1], p[0], p[1])
        if len(p) == 4:
            return (p[0], p[1], p[2], p[3])
    if isinstance(p, dict):
        return (p.get("t", p.get("y", 0)), p.get("r", p.get("x", 0)),
                p.get("b", p.get("y", 0)), p.get("l", p.get("x", 0)))
    return (0, 0, 0, 0)


def layout_axis(n):
    v = n.get("layout")
    if not v:
        return None
    v = str(v).upper()
    if v in ("V", "VERTICAL", "COLUMN", "COL"):
        return "V"
    if v in ("H", "HORIZONTAL", "ROW"):
        return "H"
    return None


def tokenize(s):
    """CJK 逐字成词，西文按词成组 —— 决定换行点"""
    out, buf = [], ""
    for ch in s:
        if ord(ch) > 0x2E7F:          # CJK / 全角标点
            if buf:
                out.append(buf)
                buf = ""
            out.append(ch)
        elif ch == " ":
            if buf:
                out.append(buf)
                buf = ""
            out.append(" ")
        else:
            buf += ch
    if buf:
        out.append(buf)
    return out


def wrap_text(s, font, max_w):
    if max_w <= 0 or not s:
        return [s or ""]
    lines, cur = [], ""
    for tok in tokenize(s):
        trial = cur + tok
        if not cur or font.getlength(trial) <= max_w:
            cur = trial
        else:
            lines.append(cur.rstrip())
            cur = "" if tok == " " else tok
    if cur:
        lines.append(cur.rstrip())
    return lines or [""]


def is_transparent(v):
    return v in (None, "#00000000") or (isinstance(v, str) and v.lower().endswith("00"))


DIAG = []   # 全局布局诊断信息


# --------------------------------------------------------------------- 测量

def is_absolute(n):
    """
    绝对定位子节点：脱离 auto-layout 布局流，按自己的 x/y 叠在父容器上。
    必须和 plugin/code.js 的 applyLayoutChild 保持一致——
    否则预览和真机对不上，「本地先验证」就失去意义（滚动淡出遮罩就是靠它）。
    """
    return str(n.get("positioning") or "").upper() == "ABSOLUTE" or n.get("absolute") is True


def measure(n, aw, ah, path):
    # 可用空间必须是数字。根节点的 w/h 可能是 "hug"/"fill"，父层也可能漏传 ——
    # 落成一个宽松预算，避免 "hug" 这种字符串被当成尺寸去做减法（会 TypeError）。
    aw = aw if num(aw) else 390
    ah = ah if num(ah) else 844
    # 绝对定位的默认坐标；auto-layout 的父容器会在 allocate() 里覆盖
    n["_x"] = n.get("x", 0) or 0
    n["_y"] = n.get("y", 0) or 0
    t = str(n.get("type", "FRAME")).upper()

    if t == "TEXT":
        size = n.get("size", 14)
        font = get_font(size, n.get("weight", 400))
        lh = n.get("lineHeight") if num(n.get("lineHeight")) else round(size * 1.4)
        txt = str(n.get("text", ""))
        wspec = n.get("w")
        if num(wspec):
            lines = wrap_text(txt, font, wspec)
            n["_w"] = wspec
            n["_h"] = n["h"] if num(n.get("h")) else lh * len(lines)
        elif wspec == "fill":
            lines = wrap_text(txt, font, max(1, aw))
            n["_w"] = max(1, aw)
            n["_h"] = n["h"] if num(n.get("h")) else lh * len(lines)
        else:
            lines = [txt]
            n["_w"] = font.getlength(txt)
            n["_h"] = n["h"] if num(n.get("h")) else lh
        n["_lines"], n["_lh"], n["_font"] = lines, lh, font
        if len(lines) > 1 and not num(n.get("h")):
            DIAG.append(f"换行 {len(lines)} 行: 「{txt[:18]}」 @ {path}")
        elif font.getlength(txt) > n["_w"] + 0.6:
            DIAG.append(f"文本溢出 {font.getlength(txt):.0f}px > 盒宽 {n['_w']:.0f}px: 「{txt[:18]}」 @ {path}")
        return

    if t in ("RECT", "ELLIPSE", "LINE"):
        n["_w"] = n["w"] if num(n.get("w")) else (max(1, aw) if n.get("w") == "fill" else 100)
        n["_h"] = n["h"] if num(n.get("h")) else (max(1, ah) if n.get("h") == "fill" else 100)
        return

    # ---- FRAME
    axis = layout_axis(n)
    pt, pr, pb, pl = pad_of(n)
    kids = n.get("children") or []
    wspec, hspec = n.get("w"), n.get("h")

    if axis is None:
        for k in kids:
            k["_path"] = f"{path} > {k.get('name', k.get('type'))}"
            measure(k, aw, ah, k["_path"])
        if num(wspec):
            n["_w"] = wspec
        else:
            n["_w"] = max([k.get("x", 0) + k["_w"] for k in kids], default=0)
        if num(hspec):
            n["_h"] = hspec
        else:
            n["_h"] = max([k.get("y", 0) + k["_h"] for k in kids], default=0)
        return

    w = wspec if num(wspec) else (max(1, aw) if wspec == "fill" else None)
    h = hspec if num(hspec) else (max(1, ah) if hspec == "fill" else None)
    cw = max(1, (w if w is not None else aw) - pl - pr)
    ch = max(1, (h if h is not None else ah) - pt - pb)

    gap = n.get("gap", 0) or 0
    # 绝对定位子节点不参与布局流，也不贡献 HUG 尺寸
    flow = [k for k in kids if not is_absolute(k)]
    # 关键：横向容器里 fill/grow 子节点只拿到「均分后的份额」。
    # 若按整个容器宽度去测量它的子树，子树会按错误宽度排版
    # （盘口两列错位、文字被截断的根因）。
    if axis == "H":
        fixed = sum((k["w"] if num(k.get("w")) else 0) for k in flow
                    if k.get("w") != "fill" and not k.get("grow"))
        nfill = sum(1 for k in flow if k.get("w") == "fill" or k.get("grow"))
        share = max(1.0, (cw - fixed - gap * max(0, len(flow) - 1)) / nfill) if nfill else cw
    else:
        share = cw
    for k in kids:
        k["_path"] = f"{path} > {k.get('name', k.get('type'))}"
        if is_absolute(k):
            # 尺寸由自己的 w/h 决定，与容器可用空间无关
            kw = k["w"] if num(k.get("w")) else 1.0
            kh = k["h"] if num(k.get("h")) else 1.0
            measure(k, max(1.0, kw), max(1.0, kh), k["_path"])
            continue
        if axis == "H" and (k.get("w") == "fill" or k.get("grow")):
            kw = share
        elif axis == "H" and num(k.get("w")):
            kw = k["w"]
        else:
            kw = cw
        measure(k, max(1.0, kw), ch, k["_path"])

    wrapped = bool(n.get("wrap")) and axis == "H"
    rows = greedy_rows(flow, cw, gap) if wrapped else [flow]

    if wrapped:
        if w is None:
            w = max([sum(k["_w"] for k in r) + gap * max(0, len(r) - 1) for r in rows], default=0) + pl + pr
        if h is None:
            h = sum(max([k["_h"] for k in r], default=0) for r in rows) + gap * max(0, len(rows) - 1) + pt + pb
    elif axis == "V":
        if w is None:
            w = max([k["_w"] for k in flow], default=0) + pl + pr
        if h is None:
            h = sum(k["_h"] for k in flow) + gap * max(0, len(flow) - 1) + pt + pb
    else:
        if h is None:
            h = max([k["_h"] for k in flow], default=0) + pt + pb
        if w is None:
            w = sum(k["_w"] for k in flow) + gap * max(0, len(flow) - 1) + pl + pr

    n["_w"], n["_h"] = w, h
    allocate(n, axis, kids, rows, wrapped)


def greedy_rows(kids, cw, gap):
    rows, cur, cur_w = [], [], 0.0
    for k in kids:
        add = k["_w"] + (gap if cur else 0)
        if cur and cur_w + add > cw + 0.5:
            rows.append(cur)
            cur, cur_w = [k], k["_w"]
        else:
            cur.append(k)
            cur_w += add
    if cur:
        rows.append(cur)
    return rows


def allocate(n, axis, kids, rows, wrapped):
    pt, pr, pb, pl = pad_of(n)
    cw = n["_w"] - pl - pr
    ch = n["_h"] - pt - pb
    gap = n.get("gap", 0) or 0
    cross_mode = str(n.get("cross") or "MIN").upper()
    main_mode = str(n.get("main") or "MIN").upper()

    # 绝对定位子节点脱离布局流：不参与弹性分配、不计 gap、不占主轴空间，
    # 最后按自己的 x/y 直接叠上去（与 plugin/code.js 的 applyLayoutChild 一致）。
    absol = [k for k in kids if is_absolute(k)]
    flow = [k for k in kids if not is_absolute(k)]
    before = [(k, k["_w"], k["_h"]) for k in flow]

    # 1) 交叉轴 fill
    for k in flow:
        spec = k.get("h") if axis == "V" else k.get("w")
        if spec == "fill":
            if axis == "V":
                k["_w"] = cw
            else:
                k["_h"] = ch

    # 2) 主轴弹性分配
    primary = "_h" if axis == "V" else "_w"
    spec_key = "h" if axis == "V" else "w"
    primary_span = ch if axis == "V" else cw
    flex, fixed_total = [], 0.0
    for k in flow:
        if k.get(spec_key) == "fill" or k.get("grow"):
            flex.append(k)
        else:
            fixed_total += k[primary]
    gap_total = gap * max(0, len(flow) - 1)
    avail = max(0.0, primary_span - fixed_total - gap_total)
    if flex:
        gsum = sum((k.get("grow") or 0) for k in flex)
        if gsum > 0:
            for k in flex:
                k[primary] = avail * ((k.get("grow") or 0) / gsum)
        else:
            for k in flex:
                k[primary] = avail / len(flex)

    used = fixed_total + sum(k[primary] for k in flex) + gap_total
    free = primary_span - used
    start = free / 2 if main_mode == "CENTER" else (free if main_mode == "MAX" else 0)
    start = max(0.0, start)
    extra_gap = (free / max(1, len(flow) - 1)) if (main_mode == "SPACE_BETWEEN" and free > 0) else 0.0

    # 3) 第二趟：尺寸被父容器改写过的 auto-layout 容器，必须用「最终尺寸」重排它的子树。
    #    必须放在定位之前——measure() 会把 _x/_y 重置为规格里的值。
    #    只对 auto-layout 容器做：grow 分配的子节点自身固有宽度是 0，
    #    重测会把父容器刚分配的宽度重置掉（占比条消失就是这个原因）。
    for k, pw, ph in before:
        if layout_axis(k) is None:
            continue
        if abs(k["_w"] - pw) > 0.01 or abs(k["_h"] - ph) > 0.01:
            measure(k, max(1.0, k["_w"]), max(1.0, k["_h"]), k.get("_path", "?"))

    # 4) 定位（只排布局流里的子节点）
    if wrapped:
        y = pt + start
        for r in rows:
            rowh = max([k["_h"] for k in r], default=0)
            x = pl
            for k in r:
                k["_x"], k["_y"] = x, y
                if cross_mode == "CENTER":
                    k["_y"] = y + (rowh - k["_h"]) / 2
                elif cross_mode == "MAX":
                    k["_y"] = y + rowh - k["_h"]
                x += k["_w"] + gap + extra_gap
            y += rowh + gap
    elif axis == "V":
        cur = pt + start
        for k in flow:
            k["_y"] = cur
            if k.get("w") != "fill":
                k["_x"] = pl + (cw - k["_w"]) / 2 if cross_mode == "CENTER" else (
                    pl + cw - k["_w"] if cross_mode == "MAX" else pl)
            else:
                k["_x"] = pl
            cur += k["_h"] + gap + extra_gap
    else:
        cur = pl + start
        for k in flow:
            k["_x"] = cur
            if k.get("h") != "fill":
                k["_y"] = pt + (ch - k["_h"]) / 2 if cross_mode == "CENTER" else (
                    pt + ch - k["_h"] if cross_mode == "MAX" else pt)
            else:
                k["_y"] = pt
            cur += k["_w"] + gap + extra_gap

    # 5) 绝对定位子节点：只用 x/y，不受 padding / 对齐 / gap 影响
    for k in absol:
        k["_x"] = pl + (k.get("x") or 0)
        k["_y"] = pt + (k.get("y") or 0)

    # 绘制顺序：绝对定位的排到最后 = 画在最上层（与 Figma 的 z 序一致）
    if absol:
        n["_children"] = flow + absol
    else:
        n["_children"] = flow


# --------------------------------------------------------------------- 绘制

def _lerp_stops(stops, t):
    """在 stops（[[pos, '#RRGGBBAA'], ...]）上按 t∈[0,1] 插值出颜色"""
    ss = sorted(((float(p), color(c) or (0, 0, 0, 0)) for p, c in stops), key=lambda x: x[0])
    if not ss:
        return (0, 0, 0, 0)
    if t <= ss[0][0]:
        return ss[0][1]
    if t >= ss[-1][0]:
        return ss[-1][1]
    for i in range(len(ss) - 1):
        p0, c0 = ss[i]
        p1, c1 = ss[i + 1]
        if p0 <= t <= p1:
            k = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
            return tuple(int(round(c0[j] + (c1[j] - c0[j]) * k)) for j in range(4))
    return ss[-1][1]


def gradient_image(w, h, spec):
    """
    线性渐变。角度约定与 plugin/code.js 的 toPaint 一致：
      90° = 上→下（stops[0] 在上），180° = 左→右（默认）。
    实现上用「1px 长条 + 放大」而不是逐像素，大画布上快得多。
    """
    stops = spec.get("stops") or []
    if not stops:
        return Image.new("RGBA", (w, h), (0, 0, 0, 0))
    rad = math.radians(float(spec.get("angle", 180)))
    dx, dy = math.cos(rad), math.sin(rad)

    if abs(dx) >= abs(dy):                      # 横向
        strip = Image.new("RGBA", (w, 1), (0, 0, 0, 0))
        span = max(1, w - 1)
        for x in range(w):
            t = x / span if dx >= 0 else 1 - x / span
            strip.putpixel((x, 0), _lerp_stops(stops, t))
        return strip.resize((w, h), Image.NEAREST)

    strip = Image.new("RGBA", (1, h), (0, 0, 0, 0))   # 纵向
    span = max(1, h - 1)
    for y in range(h):
        t = y / span if dy >= 0 else 1 - y / span
        strip.putpixel((0, y), _lerp_stops(stops, t))
    return strip.resize((w, h), Image.NEAREST)


def _shape_mask(t, w, h, radius, box):
    """形状的 alpha 遮罩：渐变填充靠它裁出圆角/椭圆"""
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    if t == "ELLIPSE":
        md.ellipse(box, fill=255)
    elif radius > 0:
        md.rounded_rectangle(box, radius=radius, fill=255)
    else:
        md.rectangle(box, fill=255)
    return mask


def image_paint(fill_spec, w, h):
    """
    图片填充。
    只支持**内嵌 base64** 的写法（`{"image": "<base64>"}`）——
    dump 读出来的是 `{image:true, imageHash:...}`，那种没有字节，只能真机渲染。
    这种情况下返回 None，由调用方退化成透明（并在诊断里提一句）。
    """
    raw = fill_spec.get("image")
    if not isinstance(raw, str):
        return None
    raw = re.sub(r"^data:[^;]*;base64,", "", raw)
    try:
        im = Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGBA")
    except Exception:
        return None
    if im.width <= 0 or im.height <= 0:
        return None

    mode = str(fill_spec.get("scaleMode") or "FILL").upper()
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    if mode == "TILE":
        tw, th = max(1, im.width), max(1, im.height)
        for y in range(0, h, th):
            for x in range(0, w, tw):
                canvas.paste(im, (x, y))
        return canvas
    if mode == "FIT":
        k = min(w / im.width, h / im.height)
    else:                       # FILL / CROP / 其它都按"铺满并居中裁剪"
        k = max(w / im.width, h / im.height)
    if abs(k - 1.0) > 1e-6:
        im = im.resize((max(1, int(round(im.width * k))), max(1, int(round(im.height * k)))),
                       Image.LANCZOS)
    canvas.paste(im, ((w - im.width) // 2, (h - im.height) // 2))
    return canvas


def draw_shape(n):
    w = max(1, int(math.ceil(n["_w"])))
    h = max(1, int(math.ceil(n["_h"])))
    t = str(n.get("type", "RECT")).upper()
    box = [0, 0, w - 1, h - 1]

    fill_spec = n.get("fill", n.get("color"))
    stroke = color(n.get("stroke", n.get("border")))
    sw = int(round(n.get("strokeWeight", n.get("borderWidth", 1)) or 1))

    r = n.get("radius")
    if isinstance(r, list):
        r = r[0] if r else 0
    r = float(r or 0)

    # 非纯色填充（渐变 / 图片）先生成一张位图，再用形状遮罩裁边
    layered = None
    if isinstance(fill_spec, dict):
        if "gradient" in fill_spec:
            layered = gradient_image(w, h, fill_spec)
        else:
            layered = image_paint(fill_spec, w, h)

    if layered is not None:
        base = layered
        if t != "LINE":
            base.putalpha(ImageChops.multiply(base.getchannel("A"),
                                              _shape_mask(t, w, h, r, box)))
        if stroke:
            sd = ImageDraw.Draw(base)
            if t == "ELLIPSE":
                sd.ellipse(box, outline=stroke, width=max(1, sw))
            elif r > 0:
                sd.rounded_rectangle(box, radius=r, outline=stroke, width=max(1, sw))
            else:
                sd.rectangle(box, outline=stroke, width=max(1, sw))
    else:
        fill = color(fill_spec)
        base = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(base)
        if t == "ELLIPSE":
            d.ellipse(box, fill=fill, outline=stroke, width=max(1, sw))
        elif t == "LINE":
            d.rectangle(box, fill=stroke or fill)
        elif r <= 0:
            d.rectangle(box, fill=fill, outline=stroke, width=max(1, sw) if stroke else 0)
        else:
            d.rounded_rectangle(box, radius=r, fill=fill, outline=stroke,
                                width=max(1, sw) if stroke else 0)

    rot = n.get("rotate") or 0
    if rot:
        base = base.rotate(-rot, expand=True, resample=Image.BICUBIC)
    # 关键：RECT/ELLIPSE 的 opacity 必须落到 alpha 通道，
    # 否则面积填充 / 量能柱 / 涨跌胶囊会变成实心色块（插件里由 Figma 处理）
    op = n.get("opacity")
    if num(op) and op < 1:
        base.putalpha(base.getchannel("A").point(lambda v: int(v * op)))
    return base


def draw_text(n):
    w = max(1, int(math.ceil(n["_w"])))
    h = max(1, int(math.ceil(n["_h"])))
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    font = n["_font"]
    col = color(n.get("fill", n.get("color", "#111111"))) or (17, 17, 17, 255)
    lh, lines = n["_lh"], n["_lines"]
    total = lh * len(lines)
    valign = str(n.get("valign") or "TOP").upper()
    y0 = (h - total) / 2 if valign == "CENTER" else (h - total if valign == "BOTTOM" else 0)
    align = str(n.get("align") or "LEFT").upper()
    asc, desc = font.getmetrics()
    for i, line in enumerate(lines):
        lw = font.getlength(line)
        x = (w - lw) / 2 if align == "CENTER" else (w - lw if align == "RIGHT" else 0)
        y = y0 + i * lh + (lh - (asc + desc)) / 2
        d.text((x, y), line, font=font, fill=col, anchor="la")
    return img


def draw_node(n):
    t = str(n.get("type", "FRAME")).upper()
    if t == "TEXT":
        return draw_text(n)
    if t in ("RECT", "ELLIPSE", "LINE"):
        return draw_shape(n)

    w = max(1, int(math.ceil(n["_w"])))
    h = max(1, int(math.ceil(n["_h"])))
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    if "fill" in n:
        bgv = n["fill"]
    elif "bg" in n:
        bgv = n["bg"]
    else:
        bgv = "#FFFFFF"
    bg = color(bgv)
    radius = n.get("radius")
    if isinstance(radius, list):
        radius = radius[0] if radius else 0
    if bg and bg[3] > 0:
        if radius:
            ImageDraw.Draw(img).rounded_rectangle([0, 0, w - 1, h - 1], radius=float(radius), fill=bg)
        else:
            ImageDraw.Draw(img).rectangle([0, 0, w - 1, h - 1], fill=bg)

    stroke = color(n.get("stroke", n.get("border")))
    if stroke:
        sw = int(round(n.get("strokeWeight", n.get("borderWidth", 1)) or 1))
        ImageDraw.Draw(img).rectangle([0, 0, w - 1, h - 1], outline=stroke, width=max(1, sw))

    # 用 allocate() 排好的顺序：绝对定位子节点在最后 = 画在最上层（与 Figma z 序一致）
    for k in n.get("_children") or n.get("children") or []:
        sub = draw_node(k)
        if sub.width <= 0 or sub.height <= 0:
            continue
        x, y = k["_x"], k["_y"]
        if k.get("rotate"):
            x = k["_x"] + k["_w"] / 2 - sub.width / 2
            y = k["_y"] + k["_h"] / 2 - sub.height / 2
        x, y = int(round(x)), int(round(y))
        if x >= w or y >= h or x + sub.width <= 0 or y + sub.height <= 0:
            continue
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        layer.paste(sub, (x, y))
        img = Image.alpha_composite(img, layer)

    op = n.get("opacity")
    if num(op) and op < 1:
        a = img.getchannel("A").point(lambda v: int(v * op))
        img.putalpha(a)
    return img


# --------------------------------------------------------------------- 主流程

def safe(s):
    return "".join(c if (c.isalnum() or c in "-_") else "_" for c in s)


def main():
    spec_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "stock-app.json")
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)

    shots = []
    for frame in spec["frames"]:
        # 根节点的 w/h 可能是 hug/fill —— 可用空间给个宽松预算即可，
        # 真正的尺寸由 measure() 按内容算出（_w/_h）。
        rw = frame.get("w", 390)
        rh = frame.get("h", 844)
        measure(frame, rw if num(rw) else 390, rh if num(rh) else 844, frame.get("name", "frame"))
        img = draw_node(frame)
        out = os.path.join(OUT, f"preview-{safe(frame.get('name', 'frame'))}.png")
        img.save(out)
        shots.append((frame, img))
        print(f"  ✔ {out}  ({img.width}×{img.height})")

    # 拼接总览图
    if shots:
        scale = 0.5
        gap = 20
        tw = int(shots[0][1].width * scale)
        th = int(shots[0][1].height * scale)
        sheet = Image.new("RGBA",
                          (tw * len(shots) + gap * (len(shots) - 1), th),
                          (30, 32, 36, 255))
        for i, (_, im) in enumerate(shots):
            sheet.paste(im.resize((tw, th), Image.LANCZOS), (i * (tw + gap), 0))
        sheet_path = os.path.join(OUT, "contact-sheet.png")
        sheet.save(sheet_path)
        print(f"  ✔ {sheet_path}  ({sheet.width}×{sheet.height})")

    print(f"\n布局诊断: {len(DIAG)} 条")
    for d in DIAG[:30]:
        print("  · " + d)
    if len(DIAG) > 30:
        print(f"  … 还有 {len(DIAG) - 30} 条")


if __name__ == "__main__":
    main()
