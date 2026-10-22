#!/usr/bin/env python3
# Serve the War2 replay viewer on http://localhost:8000/ and open it in the browser (ES modules and wasm need http://).
#   serve.py [--game DIR] [port]
# The viewer loads "Warcraft II BNE.exe", "War2Dat.mpq" and "War2Patch.mpq" by itself from /game/, which this
# server maps (read-only, those three files and plugin/peon2k.w2p only) to the War2 folder: --game DIR, else $WAR2_DIR, else the folder
# this script is in (viewer unzipped inside the War2 folder), else its game/ subfolder, else its parent, else common install paths.
import http.server, os, socketserver, sys, threading, urllib.parse, webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
GAME_FILES = ('warcraft ii bne.exe', 'war2dat.mpq', 'war2patch.mpq')
PLUGIN_FILES = ('peon2k.w2p',)

def find_files(d):
    """{lowercase name: real path} of the game files in d (case-insensitive)."""
    try: names = os.listdir(d)
    except OSError: return {}
    f = {n.lower(): os.path.join(d, n) for n in names if n.lower() in GAME_FILES and os.path.isfile(os.path.join(d, n))}
    # War2Combat plugin whose rules the viewer can follow (Peon2k): plugin/peon2k.w2p, served as /game/plugin/peon2k.w2p
    pd = next((os.path.join(d, n) for n in names if n.lower() == 'plugin' and os.path.isdir(os.path.join(d, n))), None)
    if pd:
        try: f.update({'plugin/' + n.lower(): os.path.join(pd, n) for n in os.listdir(pd) if n.lower() in PLUGIN_FILES and os.path.isfile(os.path.join(pd, n))})
        except OSError: pass
    return f

def usable(d):
    f = find_files(d)
    return d if 'war2dat.mpq' in f and 'warcraft ii bne.exe' in f else None

def candidates():
    home = os.path.expanduser('~')
    pf = [os.environ.get(k) for k in ('ProgramFiles(x86)', 'ProgramFiles')]
    yield HERE
    yield os.path.join(HERE, 'game')
    yield os.path.dirname(HERE)
    for p in filter(None, pf):
        yield os.path.join(p, 'Warcraft II BNE'); yield os.path.join(p, 'Warcraft II Battle.net Edition')
    for p in (r'C:\Program Files (x86)\Warcraft II BNE', r'C:\Program Files\Warcraft II BNE', r'C:\GOG Games\Warcraft II',
              r'C:\Games\Warcraft II BNE', os.path.join(home, 'Games', 'Warcraft II BNE'), os.path.join(home, 'Games', 'Warcraft II'),
              os.path.join(home, 'Warcraft II BNE'), os.path.join(home, 'War2Combat')):
        yield p

def main(argv):
    try: sys.stdout.reconfigure(line_buffering=True)
    except Exception: pass
    port, game = 8000, None
    it = iter(argv)
    for a in it:
        if a == '--game': game = next(it, None)
        elif a.startswith('--game='): game = a.split('=', 1)[1]
        elif a.isdigit(): port = int(a)
        else: sys.exit(f'usage: serve.py [--game DIR] [port]   (unknown argument {a!r})')
    if game:
        game = os.path.abspath(os.path.expanduser(game))
        if not usable(game): print(f'warning: {game} has no "Warcraft II BNE.exe" + War2Dat.mpq')
    elif os.environ.get('WAR2_DIR'):
        game = os.path.abspath(os.path.expanduser(os.environ['WAR2_DIR']))
        if not usable(game): print(f'warning: WAR2_DIR={game} has no "Warcraft II BNE.exe" + War2Dat.mpq')
    else:
        game = next((d for d in candidates() if usable(d)), None)
    files = find_files(game) if game else {}
    if files: print(f'Game files from {game}: ' + ', '.join(sorted(os.path.basename(p) for p in files.values())))
    else: print('No Warcraft II folder found (use --game DIR or WAR2_DIR): the page will ask for the game files.')

    class H(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript'}
        def __init__(self, *a, **k): super().__init__(*a, directory=HERE, **k)
        def log_message(self, *a): pass
        def translate_path(self, path):
            p = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
            if p.startswith('/game/'):
                # only the three game files (+ plugin/peon2k.w2p), by name (any case); nothing else of the game folder is reachable
                return files.get(p[len('/game/'):].lower(), os.path.join(HERE, '.no-such-file'))
            return super().translate_path(path)
        def do_PUT(self): self.send_error(405)
        do_POST = do_DELETE = do_PUT

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('127.0.0.1', port), H) as s:
        url = f'http://localhost:{port}/'
        print(f'War2 replay viewer at {url}  (Ctrl+C to stop)')
        if not os.environ.get('WAR2_NO_BROWSER'): threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try: s.serve_forever()
        except KeyboardInterrupt: pass

if __name__ == '__main__':
    main(sys.argv[1:])
