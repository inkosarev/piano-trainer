#!/usr/bin/env python3
"""Генерация PNG-иконок PWA (icons/icon-*.png) для тренажёра чтения нот.

Рисует глиф «клавиши пианино» одними прямоугольниками (без шрифтов),
суперсэмплинг 4x + LANCZOS для сглаживания. Палитра — из :root приложения.

Запуск:  python3 make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

# Палитра (совпадает с :root в index.html)
BG = (22, 27, 36, 255)         # #161b24 — карточка
LINE = (42, 51, 69, 255)       # #2a3345 — рамки
WHITE = (223, 227, 234, 255)   # #dfe3ea — белые клавиши
WHITE_LINE = (151, 160, 177, 255)
BLACK = (16, 20, 27, 255)      # #10141b — чёрные клавиши
BLACK_LINE = (51, 60, 77, 255)
ACCENT = (122, 162, 247, 255)  # #7aa2f7

SS = 4          # суперсэмплинг
BASE = 512      # координатная сетка глифа
OUT = Path(__file__).parent / "icons"


def draw_glyph(d: ImageDraw.ImageDraw, u: float, s: float) -> None:
    """Глиф в координатах BASE-канвы; u — пиксели на единицу сетки, s — масштаб вокруг центра."""

    def X(x: float) -> float:
        return (BASE / 2 + (x - BASE / 2) * s) * u

    def Y(y: float) -> float:
        return (BASE / 2 + (y - BASE / 2) * s) * u

    def L(v: float) -> float:
        return v * s * u

    # 4 белые клавиши: x 78..434 (ширина 86, зазор 4), y 150..428
    for i in range(4):
        d.rounded_rectangle(
            [X(78 + i * 90), Y(150), X(78 + i * 90 + 86), Y(428)],
            radius=L(10), fill=WHITE, outline=WHITE_LINE, width=max(1, round(3 * s * u)),
        )
    # 2 чёрные клавиши над границами первых трёх белых
    for bx in (166, 256):
        d.rounded_rectangle(
            [X(bx - 25), Y(150), X(bx + 25), Y(310)],
            radius=L(8), fill=BLACK, outline=BLACK_LINE, width=max(1, round(3 * s * u)),
        )
    # акцентная полоска снизу
    d.rounded_rectangle(
        [X(78), Y(448), X(434), Y(462)],
        radius=L(7), fill=ACCENT,
    )


def make(size: int, maskable: bool) -> Image.Image:
    n = size * SS
    u = n / BASE
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        # сплошной фон без скруглений, глиф в безопасной зоне (~68%)
        d.rectangle([0, 0, n - 1, n - 1], fill=BG)
        draw_glyph(d, u, 0.68)
    else:
        # скруглённый фон + глиф почти на всю площадь
        d.rounded_rectangle(
            [0, 0, n - 1, n - 1], radius=112 * u, fill=BG, outline=LINE, width=max(1, round(2 * u)),
        )
        draw_glyph(d, u, 1.0)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for size in (192, 512):
        make(size, False).save(OUT / f"icon-{size}.png")
        make(size, True).save(OUT / f"icon-maskable-{size}.png")
    for p in sorted(OUT.glob("*.png")):
        print(p, p.stat().st_size, "байт")


if __name__ == "__main__":
    main()
