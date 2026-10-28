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
* A replay: a packet capture (.pcapng / .pcap) of an IPX game, or a converted replay (.w2r, or gzipped .w2r.gz).
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

Replays folder: the "Replays" list at the top of the page shows the replays (.w2r, .w2r.gz), captures (.pcapng/.pcap),
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
recording player); its "Stats" button opens the match stats (below).

Controls: Play/Pause, Step (one network turn), speed, timeline seek, drag to scroll, wheel to zoom, click
the minimap, fog of war as any player.
Keys: Space play/pause, . step one turn, Left/Right skip 10 s back/forward, 1-8 view as player 1-8,
9 no fog, P toggle player view (that player's fog, selection, camera, UI and voices). With a player picked:
F fog on/off (the view stays on that player), L follow that player's camera on/off (its recorded screen, else its
selection; dragging the map or the minimap stops it). H toggle HP bars, Esc close the unit card, B copy a
commentary balloon entry (below).
Click a unit or building on the map (free or player view) for its stats, as the game's status panel has them, for
any player: armor, damage, range, sight with upgrade bonuses, speed, magic, current order, a worker's load, a
transport's cargo, spell timers; construction and training / research progress with the time left; gold or oil
left in a mine, food grown/used at a farm, a town hall's production rates. The card follows the unit as it plays.
Match stats (K, or the bar-chart button by the minimap) open a window over the page, for the game so far: with a
player picked (keys 1-8, or a click in the score strip), that player; with fog "all", team 1 against team 2 (as
the score strip splits them).
* Units: an icon for each unit and building type, with how many are alive now (top number) over how many were
  made (bottom; buildings when finished, an upgraded hall or tower or a unit converted by an upgrade counts again
  as its new type, as the game's own stats do); a dimmed icon means none are left. Below them the upgrades and
  spells researched, in order (point at one for when and its cost). Below them three charts:
  - Economy: gold, lumber and oil harvested per game minute (stacked above the line, smoothed) and spent (stacked
    below, each minute's total).
  - Army: the gold, lumber and oil cost of the units made in each game minute (above; starting units left out) and
    of those lost (below; killed or not, as demolition squads).
  - Army value: the gold, lumber and oil cost of what is alive: combat units and towers above, noncombat below
    (peasants / peons, tankers, transports, flying machines / zeppelins, buildings other than towers; an upgraded
    hall or tower with what it was upgraded from). Their points (what killing them scores) as white lines on their
    own scale (right axis).
* Kills: what was killed, a row per player killed (enemies first), each icon in that player's colour, in unit
  type order; friendly kills (own and team mates' units) are marked. With the cost of what was killed and of what
  was lost, and below a chart of the value killed of the other team in each game minute.
Point at or click an icon (click again to clear; on a phone, tap) to mark on the charts' time axis when those
were made (white, up) and lost or killed (red, down).
Teams' charts are one above the other on the same scale; a player's chart has the scale of the player with the
most, so it stays as you switch players. The areas count lumber x3 and oil x4 against gold. Point at a chart for
the amounts at that time. Esc or K closes the window.
Phones and tablets: tap a unit for its card (a sheet over the bottom of the map; close it with x), drag to
scroll, pinch to zoom, -10s / +10s buttons for the arrow keys. In portrait the players and events are below the
map; the player view shows the game's 4:3 screen with the card under it. Sound starts on the first tap.
Sound plays at 1x and 2x speed (positional, as the game does for the viewed player). Sliders: "vol" (master),
"voices" (unit voices; its box also plays the Fog-of-war player's selection/acknowledge voices in the free view)
and "fx" (everything else); "mics" has its own. There is no music (Battle.net Edition's music was CD audio).
The game's palette animations (water, shores, ship wakes) run as in the game.

Recording a game
----------------
Capture the game's network traffic on one of the players' computers (or on a router between them), starting
BEFORE the host clicks Start in the chat room (the start packet carries the game's random seed and slots):

    tcpdump -i <interface> -w game.pcapng 'udp port 34754 or udp port 34755'        (macOS / Linux)
    Wireshark: capture filter "udp port 34754 or udp port 34755", save as .pcapng    (Windows)

34754 is the UDP port of the game itself (War2Combat's IPX-over-UDP wrapper); 34755 carries the players' cameras
and voices from the CamRec plugin (below). The capture works on any player's computer; the viewer lets you pick
whose view (fog of war) to show. Drop the .pcapng on the page; "Save .w2r" makes a much smaller replay file.

War2Combat plugin: Peon2k
-------------------------
Games played with the Peon2k plugin (github.com/dbudor/Peon2k: peon2k.w2p v0.2.2, v0.2.3, v0.2.2.1, v0.2.3.1, and
peon2kvision.w2p of v0.2.2.1 / v0.2.3.1) replay with its rules.
A capture does not say which plugins the players had loaded, so the "Rules" selector defaults to auto: the capture
is converted with the original rules and with each Peon2k version, and the one whose game agrees with every sync
byte in the capture is kept (the status line says which). If your War2 folder has plugin/peon2k.w2p (or
plugin/peon2kvision.w2p), serve.py serves
it too: auto then tries that version first, and bloodlusted knights and paladins shout its "ajmoo" (you can also
drop the .w2p onto the page). Notes: a Peon2k rule that never changed anything in a game (no rune, tanker,
polymorph... ) cannot be detected from the capture; v0.2.2 and v0.2.3 differ only once a tanker catches fire, a .1
release from its base only once a rune hits a unit at exactly 50 hp or an invisible death knight casts unholy armor
(its scores differ too, but scores are not in the capture), and a vision build from the plain one once someone casts
holy vision. Without the plugin file auto prefers the newest release: pick the version by hand if you know it.
The vision builds of v0.2.2 / v0.2.3 (which let everybody see invisible units) and the peon2kdebug builds are not
supported.

Rejoining after a restart: extras/wsock32.dll (EXPERIMENTAL, not yet tested in a real game)
-------------------------------------------------------------------------------------------
War2Combat's network wrapper (wsock32.dll, "ipx2ip") gives every game process a new random IPX address, and each
computer remembers the address it first saw for each other computer's IP:port. When one player restarts the game,
the others keep sending to the old address and drop every packet for the new one, so the restarted player cannot
join again until EVERY player restarts. extras/wsock32.dll is the same wrapper with one change: it recognises
a sender by the address inside its packets, so a restarted player is simply a new peer.
To try it: keep a copy of the original wsock32.dll (sha1 4c747543...), then put extras/wsock32.dll (sha1
e05440fe...) into the War2Combat folder of EVERY player (the stale entries live on the computers that did not
restart). Test with two computers first: start a game, quit and restart one of them, and join again without
restarting the other. If anything misbehaves, put the original back.

Recording the players' cameras and voices: CamRec plugin
--------------------------------------------------------
plugin/camrec.w2p is a War2Combat plugin. Copy it into the plugin\ folder of every player's War2Combat install.

During a game it records that player's viewport, mouse and, in multiplayer games, microphone (only while someone
talks). It broadcasts them on the network (UDP port 34755), so your capture holds every player who ran it. It also
writes camrec\<date>-<time>-p<N>.w2c into the game folder. The game itself is not affected, and players without
the plugin can join as usual.

Microphone: everyone in the game should know they are recorded; the plugin says so with a game message
("CamRec: recording microphone (...)") a moment after the game starts. camrec.ini next to the game's exe (made on
the first game) has the settings: mic=0 turns recording off, mic_device=part-of-a-name picks the microphone
(camrec\mic-devices.txt lists them), mic_broadcast=0 keeps your voice off the network (file only). If the message
says the microphone is silent, check it is not muted and that Windows allows desktop apps to use the microphone.

In the viewer:
* the status line lists the recorded cameras;
* in the Player view the camera follows that player's own screen and shows their mouse cursor. Drag the map to look
  around; Follow / L goes back to the recording;
* in the free view each player's viewport and cursor are drawn on the map and minimap (the fog-of-war player, or
  everyone when fog is "all");
* "Cameras" (key C) turns all of this off;
* the Player view also shows that player's input (recordings by the current plugin): the drag box as they dragged it,
  a ring where they clicked (yellow left, red right), the command button they pressed, and beside the screen their
  mouse buttons, Shift / Ctrl / Alt, the last keys pressed and actions per minute. "Input" (key I) hides it;
* voices play at 1x speed, at the game time they were said: "mics" turns them on or off (with its own volume).
  With "follows view" (on at first) you hear only the player picked in Fog of war (keys 1-8). Otherwise, and with
  fog "all", you hear the players whose "mic" button in the players list you switched on (none at first; clicking
  one while "follows view" is on switches to picking by hand). The names of who is talking show over the map
  (dimmed when you are not listening to them) and the event log lists each time someone talks.

A .w2c file can be dropped onto the page next to its replay or capture (e.g. a player who was not captured).
"Save .w2r" keeps the cameras and voices in the replay.

Supported
---------
* Original multiplayer over IPX (the "legacy" network layer), Classic and Enhanced mode, 2 to 8 players,
  built-in and custom maps, players quitting or dropping mid-game, saves/restarts during the game.
* Not supported: Battle.net games (a different network protocol), modem/serial games (untested), starting an
  IPX game from a saved game.

Commentary balloons
-------------------
Comic-book speech balloons over the units, read from a JSON file: replays/<replay name>.balloons.json next to a
listed replay (e.g. 2026-10-23-game3.balloons.json for 2026-10-23-game3.w2r.gz) is loaded with it; or pick / drop a
.json file together with (or after) the replay. The file is a list (or { "balloons": [...] }):

  [
    { "time": "0:01", "text": "Four against four. Who builds faster?", "secs": 6 },
    { "time": "2:39", "unit": 1565, "text": "Right, lads, to the mine!" },
    { "time": "3:10", "unit": 1565, "text": "Zug zug!", "kind": "shout" },
    { "time": "4:00", "x": 1500, "y": 1500, "text": "Somewhere out here is the gold.", "kind": "think" }
  ]

  time   game clock when it appears, as the viewer shows it ("2:39", "1:02:05", "2:39.5", or seconds)
  text   what is said
  unit   the unit that says it; the balloon follows the unit (and stays where it was if the unit dies)
  x, y   instead of unit: a point on the map, in map pixels (32 per tile)
         with neither, it is the narrator: a caption box above the timeline
  secs   how long it stays, in game seconds (default: by the text's length, at least 3)
  kind   say (default), think or shout

To write one: click the unit and press B. An entry for that unit at the current time goes to the clipboard
(with no unit clicked, for the map point at the centre of the view); fill in its text. A balloon whose speaker is
off screen is pinned to the edge of the view, without its tail.

Credits / legal
---------------
Warcraft II is (c) Blizzard Entertainment. This is an unofficial, non-commercial fan tool for viewing your own
games; it contains no game assets and requires a legitimately owned copy of the game.

Live games
----------
A game can be watched while it is played: one of the players' PCs runs the recorder in live/ (README.txt there)
and sends the game to a relay. Live games are listed at the top of the Replay list (the relays come from
relays.json next to the viewer, {"relays": ["https://..."]}, or ?relay=URL in the address). A live game starts
at its newest turn and plays on as turns arrive; the LIVE button is red at the newest turn, else it shows how far
behind the view is and goes there when clicked. Everything else works as in a replay.
