#!/usr/bin/env python3
# Serve the War2 replay viewer on http://localhost:8000/ and open it in the browser (ES modules and wasm need http://).
#   serve.py [--game DIR] [--replays DIR] [port]
# The viewer loads "Warcraft II BNE.exe", "War2Dat.mpq" and "War2Patch.mpq" by itself from /game/, which this
# server maps (read-only, those three files and plugin/peon2k.w2p only) to the War2 folder: --game DIR, else $WAR2_DIR, else the folder
# this script is in (viewer unzipped inside the War2 folder), else its game/ subfolder, else its parent, else common install paths.
# The page's "Replays" list is /replays/index.json, made here from the replays folder: --replays DIR, else $WAR2_REPLAYS,
# else the viewer's replays/ folder. Only its replays, captures, .w2c camera files and .pud maps are served (subfolders
# two deep), read-only.
import http.server, json, os, socketserver, sys, threading, urllib.parse, webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
GAME_FILES = ('warcraft ii bne.exe', 'war2dat.mpq', 'war2patch.mpq')
PLUGIN_FILES = ('peon2k.w2p', 'peon2kvision.w2p')
REPLAY_EXT = ('.w2r', '.w2r.gz', '.pcapng', '.pcap', '.cap', '.w2c', '.pud')

def list_replays(root, depth=2):
    """[{name: path under root with '/', size, mtime}] of the replay-type files in root (subfolders `depth` deep)."""
    out = []
    def walk(d, rel, left):
        try: names = sorted(os.listdir(d))
        except OSError: return
        for n in names:
            if n.startswith('.'): continue
            p = os.path.join(d, n)
            if os.path.isdir(p):
                if left: walk(p, rel + n + '/', left - 1)
            elif n.lower().endswith(REPLAY_EXT) and os.path.isfile(p):
                st = os.stat(p); out.append({'name': rel + n, 'size': st.st_size, 'mtime': int(st.st_mtime)})
    if root: walk(root, '', depth)
    return out

def replay_path(root, rel):
    """Real path of replays/<rel> if it is a listed file under root, else None."""
    if not root or not rel.lower().endswith(REPLAY_EXT): return None
    parts = rel.split('/')
    if len(parts) > 3 or any(not x or x.startswith('.') for x in parts): return None
    p = os.path.realpath(os.path.join(root, *parts)); r = os.path.realpath(root)
    return p if p.startswith(r + os.sep) and os.path.isfile(p) else None

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
    port, game, replays = 8000, None, None
    it = iter(argv)
    for a in it:
        if a == '--game': game = next(it, None)
        elif a.startswith('--game='): game = a.split('=', 1)[1]
        elif a == '--replays': replays = next(it, None)
        elif a.startswith('--replays='): replays = a.split('=', 1)[1]
        elif a.isdigit(): port = int(a)
        else: sys.exit(f'usage: serve.py [--game DIR] [--replays DIR] [port]   (unknown argument {a!r})')
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

    replays = replays or os.environ.get('WAR2_REPLAYS') or os.path.join(HERE, 'replays')
    replays = os.path.abspath(os.path.expanduser(replays))
    if os.path.isdir(replays): print(f'Replays from {replays}: {len(list_replays(replays))} file(s)')
    else: print(f'warning: replays folder {replays} does not exist'); replays = None

    class H(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript'}
        def __init__(self, *a, **k): super().__init__(*a, directory=HERE, **k)
        def log_message(self, *a): pass
        def translate_path(self, path):
            p = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
            if p.startswith('/replays/'):
                # only replay-type files under the replays folder (index.json is made in do_GET)
                return replay_path(replays, p[len('/replays/'):]) or os.path.join(HERE, '.no-such-file')
            if p.startswith('/game/'):
                # only the three game files (+ plugin/peon2k.w2p), by name (any case); nothing else of the game folder is reachable
                return files.get(p[len('/game/'):].lower(), os.path.join(HERE, '.no-such-file'))
            return super().translate_path(path)
        def do_GET(self):
            if urllib.parse.urlsplit(self.path).path == '/replays/index.json':
                body = json.dumps(list_replays(replays)).encode()
                self.send_response(200); self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body))); self.send_header('Cache-Control', 'no-store'); self.end_headers()
                self.wfile.write(body); return
            super().do_GET()
        def do_HEAD(self):
            if urllib.parse.urlsplit(self.path).path == '/replays/index.json':
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); return
            super().do_HEAD()
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
