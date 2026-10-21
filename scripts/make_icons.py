#!/usr/bin/env python3
"""
OpenNDM-Extension 图标生成器。
Generate the OpenNDM-Extension icons.

设计：绿色圆角方块 + 白色开放圆环 + 下载箭头。
Design: green rounded square, white open ring, and a download arrow.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "img"
SIZE = 1024


def lerp(a, b, t):
    return int(a + (b - a) * t)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # 圆角方块遮罩 / Rounded-square mask.
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((58, 58, SIZE - 58, SIZE - 58), radius=236, fill=255)

    # 绿色渐变背景 / Green gradient background.
    gradient = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(gradient)
    top = (34, 166, 98)
    bottom = (10, 122, 118)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        color = (lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t), 255)
        draw.line((0, y, SIZE, y), fill=color)
    canvas.paste(gradient, (0, 0), mask)

    # 顶部柔光 / Soft top highlight.
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((120, 40, 900, 620), fill=(255, 255, 255, 24))
    canvas.alpha_composite(glow)

    overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)

    # 开放圆环，右上留缺口 / Open ring with a gap at the top-right.
    od.arc((206, 206, 818, 818), start=38, end=322, fill=(255, 255, 255, 244), width=92)

    # 下载箭头 / Download arrow.
    od.rounded_rectangle((466, 318, 558, 566), radius=46, fill=(255, 255, 255, 255))
    od.polygon([(512, 704), (350, 540), (674, 540)], fill=(255, 255, 255, 255))

    # 轻微内边框 / Subtle inner border.
    od.rounded_rectangle((58, 58, SIZE - 58, SIZE - 58), radius=236, outline=(255, 255, 255, 36), width=8)

    canvas.alpha_composite(overlay)

    # 生成常用尺寸，同时更新旧文件名以兼容缓存。
    # Export common sizes and refresh legacy names for cache compatibility.
    for size in (128, 48, 32, 16):
        resized = canvas.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(OUT / f"openndm-{size}.png", "PNG", optimize=True)
        resized.save(OUT / f"icon{size}.png", "PNG", optimize=True)

    canvas.resize((32, 32), Image.Resampling.LANCZOS).save(OUT / "icon16_2x.png", "PNG", optimize=True)

    # 统一的关闭图标 / Matching close glyph.
    close = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    cd = ImageDraw.Draw(close)
    cd.ellipse((1, 1, 31, 31), fill=(95, 99, 104, 235))
    cd.line((10, 10, 22, 22), fill=(255, 255, 255, 255), width=3)
    cd.line((22, 10, 10, 22), fill=(255, 255, 255, 255), width=3)
    close.save(OUT / "close16_2x.png", "PNG", optimize=True)
    close.resize((16, 16), Image.Resampling.LANCZOS).save(OUT / "close16.png", "PNG", optimize=True)

    print("icons written to", OUT)


if __name__ == "__main__":
    main()
