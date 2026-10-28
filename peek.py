import re
for f, pat in [('t2027.html', r'graph/2027-9-1(?!\d)'), ('tide.html', r'graph/2026-10-1(?!\d)')]:
    h = open(f, encoding='utf-8', errors='ignore').read()
    print('=====', f, '| 만조▲:', h.count('▲'), '간조▼:', h.count('▼'))
    m = re.search(pat, h)
    print('위치:', m.start() if m else None)
    if m:
        i = m.start()
        print(re.sub(r'\s+', ' ', h[max(0, i-1800): i+2200]))
