import base64, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'workbench.html')
FONT = os.path.join(HERE, 'ark-pixel-12px.woff2')
OUT = os.path.join(HERE, 'index.html')

html = open(SRC, encoding='utf-8').read()
font = open(FONT, 'rb').read()
b64 = base64.b64encode(font).decode('ascii')
uri = 'data:font/woff2;base64,' + b64

html = re.sub(
    r'<link rel="preload" href="\./ark-pixel-12px\.woff2"[^>]*>\s*',
    '', html)

old = "src:url('./ark-pixel-12px.woff2') format('woff2');"
new = "src:url('%s') format('woff2');" % uri
if old not in html:
    raise SystemExit('font src 未找到，源文件可能已改动')
html = html.replace(old, new)

open(OUT, 'w', encoding='utf-8').write(html)
print('built ->', OUT)
print('font raw   : %.1f KB' % (len(font)/1024))
print('output html: %.1f KB' % (len(html.encode('utf-8'))/1024))
