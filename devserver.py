#!/usr/bin/env python3
"""Kleiner Static-File-Server ohne Caching – praktisch während der Entwicklung,
damit Änderungen im Browser sofort ankommen. Für den produktiven Einsatz kann
stattdessen jeder normale Webserver (nginx, Apache, GitHub Pages, ...) die
Dateien in diesem Ordner ausliefern.
"""
import http.server

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

if __name__ == "__main__":
    http.server.test(HandlerClass=NoCacheHandler, port=5173)
