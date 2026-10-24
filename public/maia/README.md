# Maia-1 networks

`maia1-<rating>.bin` are the Maia-1 chess networks (human move prediction at Lichess ratings 1100–1900) by the
CSSLab at the University of Toronto, https://github.com/CSSLab/maia-chess, licensed under GPL-3.0.

McIlroy-Young, Sen, Kleinberg, Anderson: *Aligning Superhuman AI with Human Behavior: Chess as a Model System*,
KDD 2020.

Converted with `lc0 leela2onnx` and `scripts/build-maia.mjs`: the residual tower and policy head only, as
float16. The policy move order in `src/maia/lc0Moves.json` follows Leela Chess Zero (GPL-3.0).
