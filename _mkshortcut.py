import os

URL = 'https://dusash.github.io/workbench/'
content = (
    '[InternetShortcut]\n'
    f'URL={URL}\n'
    'IconIndex=0\n'
)

targets = [
    os.path.join(os.path.expanduser('~'), 'Desktop', '工作台.url'),
    os.path.join(os.environ['APPDATA'], r'Microsoft\Windows\Start Menu\Programs\Startup', '工作台.url'),
]

for t in targets:
    os.makedirs(os.path.dirname(t), exist_ok=True)
    with open(t, 'w', encoding='utf-8', newline='\r\n') as f:
        f.write(content)
    print('written:', t, os.path.getsize(t), 'bytes')
