# Chess Analyzer

A Lichess / Chess.com style game review that runs entirely in the browser.

**Live:** https://henrikamnas.github.io/chess-analyzer/

- Import recent games by **Lichess** or **Chess.com** username, or paste a PGN
- **Stockfish 19** in Web Workers: the lite build (1.6 MB) for the fast review and live analysis, and the full build (~99 MB, multi-threaded) for **Deep analysis** and the optional "Full" live engine
- Move labels (best / good / inaccuracy / mistake / blunder) and per-side **accuracy**, both based on the change in win% ([Lichess' formula](https://lichess.org/page/accuracy))
- **Estimated rating** per player, calibrated on real Chess.com rapid games
- Plain-language explanations of mistakes, with "Why it's bad" / "Better move" lines to step through
- Game summary with accuracy by phase and key moments
- Eval bar, clickable eval graph, multi-line engine analysis, and free exploration of side lines on the board
- Works on phones; the open game and its review survive reloads (stored in the browser)

## Run

```sh
npm install   # postinstall copies Stockfish and coi-serviceworker into public/
npm run dev
```

Keys: ←/→ step through moves, ↑/↓ jump to the start/end, `f` flips the board.

## Deploy

Every push to `main` builds and deploys to GitHub Pages (`.github/workflows/pages.yml`).

The multi-threaded engine needs a cross-origin isolated page (COOP/COEP headers). The Vite dev server sends
them (`vite.config.ts`); on GitHub Pages, which can't set headers, [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)
adds them in the browser (the first visit reloads once).

## Layout

| File | Purpose |
|---|---|
| `src/engine.ts` | UCI wrapper around the Stockfish worker; scores are normalized to White's view |
| `src/analysis.ts` | PGN parsing, win%, move classification, accuracy, rating estimate, full-game review |
| `src/explain.ts` | Plain-language move explanations and the game summary |
| `src/imports.ts` | Lichess and Chess.com public API clients |
| `src/session.ts` | Remembers the open game and review across reloads |
| `src/components/` | Board (chessground), eval bar and graph, move list, engine lines, summary, side-line banner |

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). The app bundles [Stockfish](https://github.com/official-stockfish/Stockfish)
via [stockfish.js](https://github.com/nmrugg/stockfish.js) (GPLv3) and [chessground](https://github.com/lichess-org/chessground) (GPLv3).
