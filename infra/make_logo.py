# Erzeugt das Logo von Empfang KI: Symbol (Klingelknopf als Sprechblase), Logo mit Schriftzug, Favicons.
import math, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'assets', 'brand')
FONT = os.path.join(os.path.dirname(__file__), '..', 'web', 'assets', 'fonts', 'schibsted-grotesk-latin-800-normal.woff2')
os.makedirs(OUT, exist_ok=True)

INK = '#1b2a3a'
PETROL = '#0e5e63'

def pt(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)

def mark_defs(uid):
    return f'''
    <linearGradient id="brass-{uid}" x1="0.15" y1="0.05" x2="0.85" y2="1">
      <stop offset="0" stop-color="#ecd08e"/><stop offset="0.45" stop-color="#c39645"/><stop offset="1" stop-color="#8a6326"/>
    </linearGradient>
    <radialGradient id="glass-{uid}" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#5cc2b4"/><stop offset="0.55" stop-color="#16797a"/><stop offset="1" stop-color="{PETROL}"/>
    </radialGradient>'''

def mark_body(uid, x=0, y=0, s=1.0):
    cx, cy, r = 32, 29, 25
    a1 = pt(cx, cy, r, 112)   # Ansatz Sprechblasen-Spitze (unten)
    a2 = pt(cx, cy, r, 148)   # Ansatz (links)
    tip = (12.5, 59.5)
    bubble = (f'M{a1[0]:.2f} {a1[1]:.2f} Q19 54 {tip[0]} {tip[1]} Q15 50 {a2[0]:.2f} {a2[1]:.2f} '
              f'A{r} {r} 0 1 1 {a1[0]:.2f} {a1[1]:.2f} Z')
    return f'''<g transform="translate({x} {y}) scale({s})">
      <path d="{bubble}" fill="url(#brass-{uid})"/>
      <path d="{bubble}" fill="none" stroke="#6f5120" stroke-opacity="0.35" stroke-width="1"/>
      <circle cx="{cx}" cy="{cy}" r="16" fill="#5a3f12" fill-opacity="0.38"/>
      <circle cx="{cx}" cy="{cy}" r="13.2" fill="url(#glass-{uid})"/>
      <ellipse cx="27.5" cy="24" rx="5.2" ry="3.4" fill="#ffffff" fill-opacity="0.38" transform="rotate(-28 27.5 24)"/>
    </g>'''

def mark_svg(size=64, bg=None, pad=0):
    vb = 64 + 2 * pad
    bgrect = f'<rect width="{vb}" height="{vb}" rx="{vb*0.22:.1f}" fill="{bg}"/>' if bg else ''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb} {vb}" width="{size}" height="{size}" role="img" aria-label="Empfang KI">
  <defs>{mark_defs("m")}</defs>{bgrect}
  {mark_body("m", pad, pad)}
</svg>'''

# ---- Schriftzug als Pfade (unabhängig von installierten Schriften)
font = TTFont(FONT)
gs = font.getGlyphSet()
cmap = font.getBestCmap()
upm = font['head'].unitsPerEm
hmtx = font['hmtx']

def text_path(text, size, x0, baseline, tracking=-0.02):
    scale = size / upm
    x = x0
    parts = []
    for ch in text:
        gname = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        tpen = TransformPen(pen, (scale, 0, 0, -scale, x, baseline))
        gs[gname].draw(tpen)
        parts.append(pen.getCommands())
        x += hmtx[gname][0] * scale + tracking * size
    return ' '.join(p for p in parts if p), x

def full_logo(color=INK, file='logo.svg'):
    size = 46
    d, end = text_path('Empfang KI', size, 78, 47)
    width = math.ceil(end + 4)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 64" width="{width*2}" height="128" role="img" aria-label="Empfang KI">
  <defs>{mark_defs("l")}</defs>
  {mark_body("l")}
  <path d="{d}" fill="{color}"/>
</svg>'''
    open(f'{OUT}/{file}', 'w').write(svg)
    return width

w = full_logo(INK, 'logo.svg')
full_logo('#ffffff', 'logo-weiss.svg')
open(f'{OUT}/logo-symbol.svg', 'w').write(mark_svg(64))
open(os.path.join(os.path.dirname(__file__), '..', 'web', 'favicon.svg'), 'w').write(mark_svg(32))
# App-Icon mit hellem Hintergrund (für Apple/Android, quadratisch)
open(f'{OUT}/app-icon.svg', 'w').write(mark_svg(512, bg='#e9ece6', pad=10))
print('ok, Logo-Breite', w)
