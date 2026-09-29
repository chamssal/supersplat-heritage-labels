#!/usr/bin/env python3
"""SuperSplat (세그먼트 라벨 판) 로컬 실행 서버.

    python3 serve.py            # http://localhost:3000 으로 dist/ 를 띄운다
    python3 serve.py 8080       # 포트를 바꾸고 싶을 때

Chrome 또는 Edge에서 열어야 합니다 (WebGPU 필요). Safari는 아직 안 됩니다.
"""
import http.server
import mimetypes
import os
import socketserver
import sys
import webbrowser

# 파이썬 기본 테이블에 없는 타입을 채워준다. 특히 .wasm 은 MIME 이 틀리면
# WebAssembly.instantiateStreaming 이 실패한다.
for ext, ctype in (
    ('.wasm', 'application/wasm'),
    ('.js', 'text/javascript'),
    ('.mjs', 'text/javascript'),
    ('.json', 'application/json'),
    ('.css', 'text/css'),
    ('.webp', 'image/webp'),
):
    mimetypes.add_type(ctype, ext)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3000


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 캐시 때문에 옛 번들이 뜨는 일을 막는다
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True


if not os.path.isdir(ROOT):
    sys.exit(f'dist 폴더가 없습니다: {ROOT}')

with Server(('127.0.0.1', PORT), Handler) as httpd:
    url = f'http://localhost:{PORT}/'
    print(f'SuperSplat 실행 중 → {url}')
    print('종료하려면 Ctrl+C')
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n종료했습니다.')
