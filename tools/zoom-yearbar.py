"""
zoom-yearbar.py —— 把年份栏前后两张全视口截图裁出「前 6 个 chip」并放大对比

为什么单独做：`ui-pair-720p-years.png` 是整条 1280px 宽，chip 只占 20px 高，
主人的屏幕上很难看出"紧凑"到底紧了多少；而且未登录时 B站 的登录引导气泡
会盖住条中部（与本次改动无关）。所以这里只裁左侧一段、放大 2.5× 拼图。

用法：python tools/zoom-yearbar.py <vp> [zoom]      # vp 默认 720p
输入：tools/.e2e-anime-out/ui-{before,after}-<vp>-full.png
产出：tools/.e2e-anime-out/ui-zoom-<vp>-yearbar.png
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".e2e-anime-out")
VP = sys.argv[1] if len(sys.argv) > 1 else "720p"
ZOOM = float(sys.argv[2]) if len(sys.argv) > 2 else 2.5

# 年份栏在图里的位置：靠 .bgm-years 的 rect 出来的 y 区间（720p 下 = 111..151 改前 / 111..141 改后）
BAND = {"720p": (108, 154), "hi2x": (236, 332)}.get(VP, (108, 154))
CROP_W = {"720p": 560, "hi2x": 900}.get(VP, 560)

FONTS = [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]


def font(size):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default()


rows = []
for tag in ("before", "after"):
    p = os.path.join(OUT, f"ui-{tag}-{VP}-full.png")
    if not os.path.exists(p):
        print(f"  跳过（不存在）：{p}")
        continue
    im = Image.open(p).convert("RGB")
    k = im.width / (1280.0 if VP == "720p" else 1440.0)      # 图像缩放系数
    r = im.crop((0, round(BAND[0] * k), round(CROP_W * k), round(BAND[1] * k)))
    r = r.resize((round(r.width * ZOOM / k), round(r.height * ZOOM / k)), Image.LANCZOS)
    rows.append((tag, r))

if len(rows) < 2:
    print("  图不全，无法拼合")
    sys.exit(0)

f = font(15)
lab_w, pad = 96, 8
w = max(r.width for _, r in rows) + lab_w + pad * 2
h = pad + sum(r.height + pad for _, r in rows)
canvas = Image.new("RGB", (w, h), (246, 247, 248))
dr = ImageDraw.Draw(canvas)
y = pad
for tag, r in rows:
    canvas.paste(r, (lab_w + pad, y))
    dr.text((pad + 2, y + r.height // 2 - 9), tag, fill=(40, 40, 40), font=f)
    y += r.height + pad
dest = os.path.join(OUT, f"ui-zoom-{VP}-yearbar.png")
canvas.save(dest)
print(f"  {os.path.basename(dest)} -> {canvas.size}")
