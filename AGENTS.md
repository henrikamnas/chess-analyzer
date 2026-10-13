# Notes for coding agents

## Checking UI changes in a real browser

UI changes should be checked in a browser, not just type-checked. Playwright isn't a dependency of this
repo; use the copy inside the global `@playwright/mcp` install and drive the installed Edge.

1. Start the dev server in the background: `npx vite --port 5199 --strictPort`
2. Run a Node script (keep it outside the repo, e.g. in a temp dir) along these lines:

```js
// node shot.cjs "$(npm root -g)"
const { createRequire } = require('module')
const { chromium } = createRequire(process.argv[2] + '/@playwright/mcp/node_modules/')('playwright')

;(async () => {
  // channel 'msedge': the Chromium builds Playwright downloads don't match this Playwright version
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1300, height: 900 } })).newPage()
  await page.goto('http://localhost:5199/')
  // Load a game: "Load game" (if the import panel is closed) → "Paste PGN" → textarea → "Analyze"
  if (!(await page.locator('textarea').count())) {
    if (!(await page.getByRole('button', { name: 'Paste PGN' }).count())) await page.getByRole('button', { name: 'Load game' }).click()
    await page.getByRole('button', { name: 'Paste PGN' }).click()
  }
  await page.fill('textarea', PGN)
  await page.getByRole('button', { name: 'Analyze' }).click()
  await page.waitForSelector('.stat-acc', { timeout: 180000 }) // review done (Opera Game ≈ 1 min)
  // Step through the game: "Start" button, then ArrowRight once per ply
  await page.getByRole('button', { name: 'Start' }).click()
  for (let i = 0; i < 31; i++) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(800)
  await page.locator('.card.verdict').first().screenshot({ path: 'card.png' })
  await page.screenshot({ path: 'full.png' })
  await browser.close()
})()
```

3. Look at the screenshots (e.g. with the Read tool), then stop the dev server.

Tips:
- The Opera Game (Morphy, 1858) is a good test game: it has book moves, best moves and a brilliant move (16. Qb8+, ply 31).
- The move list is on the "Moves" tab, not visible on the Summary tab.
- The great-move pass runs about 20 s after the review finishes; wait for it before checking "!" badges.
