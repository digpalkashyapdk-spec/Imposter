# IMPOSTER — Multiplayer Party Game

A browser-based social deduction game built with Node.js, Express and Socket.IO.

## Current rules
- Private rooms with **3–10 players maximum** (host counts as a player).
- Host chooses a match length from **5 to 30 rounds** in the lobby.
- Exactly **one imposter** is selected each round.
- Majority receives the same secret word; the imposter receives a related word.
- Players give one clue each, then discuss and vote anonymously.
- If the vote is tied, players vote again between the tied candidates. If the revote is still tied, the imposter escapes.
- If caught, the imposter gets 20 seconds to guess the majority word for a +1 bonus point.

## Scoring
- Correctly voting for the imposter when they are caught: **+2 points**.
- Incorrect vote: **0 points**.
- Imposter caught: **−1 point**.
- Caught imposter guesses the majority word correctly: **+1 bonus point**.
- Imposter escapes: **0 points** (no additional escape bonus).

The live leaderboard updates after each scoring change and the final standings remain visible when the match ends.

## Run locally
1. Install Node.js 18 or newer.
2. Extract this project and open a terminal in the project folder.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000` in your browser.

To play with friends on other devices, the server must be deployed to a public host and the players must open that hosted URL. Running on localhost only makes the game available on your own device unless you configure local-network access.

## Notes
- Rooms and scores are stored in server memory and disappear when the server restarts.
- This is an MVP, not a hardened public service. Add persistent storage, reconnect handling, rate limiting, moderation and deployment security before opening it to a large public audience.
