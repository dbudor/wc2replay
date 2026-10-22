War2 Replay Viewer
==================

Watch Warcraft II: Battle.net Edition (2.02) multiplayer IPX games again, from a packet capture, in the browser.

The game simulation inside (sim.wasm) is a bit-exact C reimplementation of the original game logic. It replays
every command of every player in lockstep and arrives at exactly the same game state the players had, turn by turn.
Nothing is guessed or interpolated.

You need
--------
* Your own copy of Warcraft II: Battle.net Edition 2.02: the files "Warcraft II BNE.exe" and "War2Dat.mpq"
  (and "War2Patch.mpq" if your install has one). This package contains no Blizzard game data; the viewer reads
  graphics, maps and unit data from your files, inside your browser. Nothing is uploaded anywhere.
* A replay: a packet capture (.pcapng / .pcap) of an IPX game, or a converted replay (.w2r).
  replays/ has samples: a 1v1 Classic game on Garden of War (.w2r) and a 1v1 capture on Islands in the stream
  (game2.pcapng, with one player's recorded camera).

Start
-----
The page must be served over http:// (browsers don't run WebAssembly modules from file://).
Easiest: unzip this folder INSIDE your Warcraft II folder (the one with "Warcraft II BNE.exe" and War2Dat.mpq),
then
* macOS:   double-click serve.command   (if blocked: right-click > Open)
* Windows: double-click serve.bat       (needs Python 3: https://www.python.org/)
* Linux:   python3 serve.py
It opens http://localhost:8000/ and the page loads the game files by itself: you only pick or drop a replay.

serve.py looks for the game folder in this order: "--game DIR" (serve.py --game "D:\Games\Warcraft II BNE" [port]),
the WAR2_DIR environment variable, the viewer's own folder, the folder above it, then common install paths
(C:\Program Files (x86)\Warcraft II BNE, C:\GOG Games\Warcraft II, ~/Games/...). It prints which one it uses and
serves only "Warcraft II BNE.exe", War2Dat.mpq and War2Patch.mpq from it (read-only, to your own browser on
localhost). serve.command / serve.bat pass their arguments on to serve.py.

Replays folder: the "Replays" list at the top of the page shows the replays (.w2r), captures (.pcapng/.pcap),
CamRec camera files (.w2c) and maps (.pud) in the viewer's replays/ folder (and its subfolders, two deep), newest
first; picking one loads it. A replay or capture on a custom map brings its .pud along when the folder has it.
Point it at another folder with --replays DIR (or the WAR2_REPLAYS environment variable), e.g. where you save
your captures:  serve.py --replays ~/war2combat   (Windows: serve.bat --replays "D:\Captures"). The list is
re-read when you come back to the page, so new captures show up. Only those file types are served from it.

Without a game folder (or on any static web host: plain HTML/JS/wasm; game files placed in the page's folder or
its game/ subfolder are also picked up), click "Game files..." (or drag and drop) and pick the game exe,
War2Dat.mpq, optionally War2Patch.mpq, and the replay. Only version 2.02 of Warcraft II BNE is supported.

A replay starts on the game's chat-room screen (who played, races, map and options); press Play to start. At the
end the game's victory / defeat statistics screen is shown for the player picked under "Fog of war" (or the
recording player).

Controls: Play/Pause, Step (one network turn), speed, timeline seek, drag to scroll, wheel to zoom, click
the minimap, fog of war as any player.
Keys: Space play/pause, . step one turn, Left/Right skip 10 s back/forward, 1-8 view as player 1-8,
9 no fog, P toggle player view (that player's fog, selection, camera, UI and voices), F re-follow the
selection in player view, H toggle HP bars, Esc close the unit card.
Click a unit or building on the map (free or player view) for its stats, as the game's status panel has them, for
any player: armor, damage, range, sight with upgrade bonuses, speed, magic, current order, a worker's load, a
transport's cargo, spell timers; construction and training / research progress with the time left; gold or oil
left in a mine, food grown/used at a farm, a town hall's production rates. The card follows the unit as it plays.
Sound plays at 1x and 2x speed (positional, as the game does for the viewed player); the "voices" box adds unit
selection/acknowledge voices. The game's palette animations (water, shores, ship wakes) run as in the game.
Battle.net Edition's music was CD audio and is not in War2Dat.mpq; if you have the tracks as HUMAN1.WAV ... ORC6.WAV
you can drop them in with the other files and tick "music".

Recording a game
----------------
Capture the game's network traffic on one of the players' computers (or on a router between them), starting
BEFORE the host clicks Start in the chat room (the start packet carries the game's random seed and slots):

    tcpdump -i <interface> -w game.pcapng udp port 34754            (macOS / Linux)
    Wireshark: capture filter "udp port 34754", save as .pcapng       (Windows)

34754 is the UDP port used by IPX-over-UDP wrappers such as ipxwrapper (War2Combat). The capture works for
any player's point of view; the viewer lets you pick whose view (fog of war) to show.

War2Combat plugin: Peon2k
-------------------------
Games played with the Peon2k plugin (github.com/dbudor/Peon2k, peon2k.w2p v0.2.2 or v0.2.3) replay with its rules.
A capture does not say which plugins the players had loaded, so the "Rules" selector defaults to auto: the capture
is converted with the original rules and with each Peon2k version, and the one whose game agrees with every sync
byte in the capture is kept (the status line says which). If your War2 folder has plugin/peon2k.w2p, serve.py serves
it too: auto then tries that version first, and bloodlusted knights and paladins shout its "ajmoo" (you can also
drop the .w2p onto the page). Notes: a Peon2k rule that never changed anything in a game (no rune, tanker,
polymorph... ) cannot be detected from the capture; v0.2.2 and v0.2.3 differ only once a tanker catches fire.
The peon2kvision/peon2kdebug builds are not supported.

Recording the players' cameras: CamRec plugin
----------------------------------------------
plugin/camrec.w2p is a War2Combat plugin. Copy it into the plugin\ folder of every player's War2Combat install.

During a game it records that player's viewport and mouse. It broadcasts them on the network (UDP port 34755), so
your capture holds every player who ran it. It also writes camrec\<date>-<time>-p<N>.w2c into the game folder.
The game itself is not affected, and players without the plugin can join as usual.

In the viewer:
* the status line lists the recorded cameras;
* in the Player view the camera follows that player's own screen and shows their mouse cursor. Drag the map to look
  around; Follow / F goes back to the recording;
* in the free view each player's viewport and cursor are drawn on the map and minimap (the fog-of-war player, or
  everyone when fog is "all");
* "Cameras" (key C) turns all of this off.

A .w2c file can be dropped onto the page next to its replay or capture (e.g. a player who was not captured).
"Save .w2r" keeps the cameras in the replay.

Supported
---------
* Original multiplayer over IPX (the "legacy" network layer), Classic and Enhanced mode, 2 to 8 players,
  built-in and custom maps, players quitting or dropping mid-game, saves/restarts during the game.
* Not supported: Battle.net games (a different network protocol), modem/serial games (untested), starting an
  IPX game from a saved game.

Credits / legal
---------------
Warcraft II is (c) Blizzard Entertainment. This is an unofficial, non-commercial fan tool for viewing your own
games; it contains no game assets and requires a legitimately owned copy of the game.
