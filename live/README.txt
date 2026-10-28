w2live: watch Warcraft II games while they are played
======================================================

One of the players' PCs records the game as it is played and sends it to a relay; anyone with the viewer
link watches it there, a turn or so behind the game. Nothing is installed into the game and nothing runs inside
it: the recorder reads the LAN traffic the way Wireshark does (it is how the replays so far were captured).

  game PC: dumpcap -> w2live.mjs -> relay (Cloudflare Worker, or relay.mjs on any computer) -> viewers

On the game PC (Windows, Warcraft II / War2Combat, Wireshark installed)
-----------------------------------------------------------------------
1. Install Node.js (LTS, https://nodejs.org) once.
2. Copy this folder anywhere, copy w2live.json.example to w2live.json and set:
     game    the War2Combat folder (Warcraft II BNE.exe, War2Dat.mpq, plugin\)
     relay   url and token of the relay (below); leave it out to record to files only
     iface   dumpcap's interface number(s) for the LAN ("node w2live.mjs --list-ifaces"); empty: all of them,
             keeping the first one the game's traffic shows up on
     delay   seconds viewers are held back (0: as it happens)
     title   shown in the viewer's list of live games
3. Start w2live.bat before the game (it may stay open all evening: it records one game after the other).

The rules come from the game folder: the recorder hashes plugin\*.w2p and knows the released Peon2k builds
(0.2.2, 0.2.2.1, 0.2.3, 0.2.3.1 and their vision builds). It runs at below-normal priority and never waits on
the network. For each game it writes to "out" (default: recordings\ next to it):
  <id>.live.w2r.gz   the stream so far (readable at any moment)
  <id>.w2r.gz        the finished replay, the same file the viewer makes from the capture
  <date>-capture.pcapng  everything captured, to convert in the viewer if anything went wrong

The relay
---------
Either:
  - Cloudflare (free plan): in this folder, "npx wrangler deploy" then "npx wrangler secret put TOKEN"
    (worker.js, wrangler.toml). Its URL goes into w2live.json and into the viewer's relays.json.
  - Any computer with Node.js: "node relay.mjs --port 8080 --token SECRET [--viewer ..]" (relay.bat).
    With --viewer it also serves the viewer, so on a LAN everyone opens http://that-computer:8080/.
Not the game PC itself: every viewer would download from it while the game is played.

The viewer
----------
Live games show at the top of the Replay list (relays.json next to the viewer lists the relays:
{"relays": ["https://w2live.YOURNAME.workers.dev"]}, or add ?relay=URL to the viewer's address). Picking one
starts at the newest turn; the red LIVE button shows when the view is at the newest turn, else how far behind it
is (click it to catch up). Seeking back works as in a replay. A link straight to a game: #live=<id>&relay=<url>.
