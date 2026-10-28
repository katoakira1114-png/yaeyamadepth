#!/usr/bin/env python3
"""Write files.json (path -> sha1) for every web file. Run before each push; the in-app update button diffs against it."""
import hashlib, json, os, time
ROOT = os.path.dirname(os.path.abspath(__file__))
TOP = ['index.html', 'app.js', 'extras.js', 'capture.js', 'view3d.js', 'layers3d.js', 'native.js', 'manifest.webmanifest',
       'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']
files = {}
def add(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f: files[rel] = hashlib.sha1(f.read()).hexdigest()
for t in TOP: add(t)
for d in ('lib', 'data'):
    for dp, _, fs in os.walk(os.path.join(ROOT, d)):
        for n in sorted(fs): add(os.path.relpath(os.path.join(dp, n), ROOT).replace(os.sep, '/'))
old = {}
try: old = json.load(open(os.path.join(ROOT, 'files.json')))
except Exception: pass
build = old.get('build', 0)
if old.get('files') != files: build = int(time.time())
json.dump({'build': build, 'files': dict(sorted(files.items()))}, open(os.path.join(ROOT, 'files.json'), 'w'), indent=0)
print('files.json:', len(files), 'files, build', build)
