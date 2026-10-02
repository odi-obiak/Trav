"""Local dev server for the landing page. Same as `python3 -m http.server`, but tells the browser not to cache,
so edits to the page, CSS or JS modules show up on a normal reload. Local testing only."""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5180


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
        print(f"Serving http://localhost:{PORT}/ (no-cache)")
        httpd.serve_forever()
