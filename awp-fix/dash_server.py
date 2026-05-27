#!/usr/bin/env python3
"""AWP Dashboard HTTP server with Basic Auth."""
import base64, os, sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("DASH_PORT", "8080"))
USER = os.environ.get("DASH_USER", "awp")
PASS = os.environ.get("DASH_PASS")
DASH_DIR = "/root/.awp-mining"

if not PASS:
    print("ERROR: DASH_PASS env var required", file=sys.stderr)
    sys.exit(1)

EXPECTED = "Basic " + base64.b64encode(f"{USER}:{PASS}".encode()).decode()


class AuthHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DASH_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        if auth != EXPECTED:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="AWP Dashboard"')
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h1>401 Unauthorized</h1>")
            return
        # Default to dashboard.html on /
        if self.path in ("/", ""):
            self.path = "/dashboard.html"
        return super().do_GET()

    def log_message(self, fmt, *args):
        # Quieter logs
        client = self.client_address[0]
        msg = fmt % args
        sys.stderr.write(f"[{self.log_date_time_string()}] {client} {msg}\n")


def main():
    addr = ("0.0.0.0", PORT)
    srv = ThreadingHTTPServer(addr, AuthHandler)
    srv.daemon_threads = True
    print(f"AWP Dashboard server: http://0.0.0.0:{PORT}/ (user={USER})", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("Shutdown", file=sys.stderr)


if __name__ == "__main__":
    main()
