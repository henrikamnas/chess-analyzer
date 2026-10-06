# Chess Analyzer

A Lichess / Chess.com style game review that runs entirely in the browser.

- Import recent games by **Lichess** or **Chess.com** username, or paste a PGN
- **Stockfish 19** (lite WASM build, single-threaded) in Web Workers: one reviews the whole game, one gives live analysis of the current position
- Move labels (best / good / inaccuracy / mistake / blunder) and per-side **accuracy**, both based on the change in win% ([Lichess' formula](https://lichess.org/page/accuracy))
- Eval bar, clickable eval graph, best-move arrows, and free exploration of side lines on the board
- Works on phones

## Run

```sh
npm install   # postinstall copies the Stockfish build into public/engine
npm run dev
```

Keys: ←/→ step through moves, ↑/↓ jump to the start/end, `f` flips the board.

## Layout

| File | Purpose |
|---|---|
| `src/engine.ts` | UCI wrapper around the Stockfish worker; scores are normalized to White's view |
| `src/analysis.ts` | PGN parsing, win%, move classification, accuracy, full-game review |
| `src/imports.ts` | Lichess and Chess.com public API clients |
| `src/components/` | Board (chessground), eval bar and graph, move list, import panel |

Stockfish.js is GPLv3.
