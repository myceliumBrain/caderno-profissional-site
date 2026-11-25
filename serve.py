#!/usr/bin/env python3
"""
Servidor estático local do Caderno: http://localhost:8000
(a criptografia do navegador exige https:// ou localhost).
Os dados são lidos e gravados direto no GitHub, como no site publicado.

Uso: python3 serve.py [porta]
"""
import http.server
import os
import sys

RAIZ = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=RAIZ, **kwargs)

    def end_headers(self):
        # Sem cache local: senão o navegador continua usando CSS/JS antigos.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    servidor = http.server.ThreadingHTTPServer(("127.0.0.1", porta), Handler)
    print(f"Caderno em http://localhost:{porta}  (Ctrl+C para parar)")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
