"""
pair-ui-shots.py —— 把 shot-badges-years.mjs 的前后两组截图拼成对照图

用法：python tools/pair-ui-shots.py <tagBefore> <tagAfter> [viewport]
      viewport 默认 720p（1280×720 · 1× DPR，主人的真实观感）

产出：tools/.e2e-anime-out/ui-pair-<vp>-years.png   ← 年份栏：上改前 / 下改后
      tools/.e2e-anime-out/ui-pair-<vp>-cards.png   ← 第一行卡片：上改前 / 下改后

⚠️ 中文标签必须显式加载系统字体（Pillow 默认位图字体画不出汉字，会变成方块）。
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".e2e-anime-out")

tag_before = sys.argv[1] if len(sys.argv) > 1 else "before"
tag_after = sys.argv[2] if len(sys.argv) > 2 else "after"
VP = sys.argv[3] if len(sys.argv) > 3 else "720p"

FONT_CANDIDATES = [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc",
                   r"C:\Windows\Fonts\simhei.ttf"]


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default()


def build(kind):
    paths = [(tag_before, os.path.join(OUT, f"ui-{tag_before}-{VP}-{kind}.png")),
             (tag_after, os.path.join(OUT, f"ui-{tag_after}-{VP}-{kind}.png"))]
    imgs = []
    for tag, p in paths:
        if not os.path.exists(p):
            print(f"  跳过（不存在）：{p}")
            continue
        imgs.append((tag, Image.open(p).convert("RGB")))
    if len(imgs) < 2:
        print(f"  {kind}：图不全，无法拼合")
        return None

    f_lab = load_font(15)
    lab_w, pad = 96, 8
    w = max(im.width for _, im in imgs) + lab_w + pad * 2
    h = pad + sum(im.height + pad for _, im in imgs)
    canvas = Image.new("RGB", (w, h), (246, 247, 248))
    dr = ImageDraw.Draw(canvas)
    y = pad
    for tag, im in imgs:
        canvas.paste(im, (lab_w + pad, y))
        dr.text((pad + 2, y + im.height // 2 - 16), tag, fill=(40, 40, 40), font=f_lab)
        y += im.height + pad
    dest = os.path.join(OUT, f"ui-pair-{VP}-{kind}.png")
    canvas.save(dest)
    print(f"  {os.path.basename(dest)} -> {canvas.size}")
    return dest


if __name__ == "__main__":
    print(f"拼合对照图：{tag_before}  vs  {tag_after}  （视口 {VP}）")
    for k in ("years", "cards"):
        build(k)
