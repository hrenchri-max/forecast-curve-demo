# Forecast Curve Editor (demo)

Live: https://hrenchri-max.github.io/forecast-curve-demo/

A small, dependency-free prototype of an editable forecasting graph:

- Preset curves: bell, linear, front-loaded, back-loaded, S-curve, flat
- Drag a single point, or drag the curve itself with a smooth brush (Shift+drag or "Drag curve" mode)
- A fixed total that holds exactly while values rebalance
- Locked periods (click a month label or the lock icon)
- Freehand drawing converted into monthly values
- Monthly and quarterly views (quarterly is a read-only roll-up)
- Excel import and export (SheetJS)
- Named versions saved in the browser, plus undo

Plain HTML, CSS and JavaScript with SVG rendering. No build step: open `index.html` through any static server.

## How the rebalancing works

All the math lives in the `ForecastMath` module at the top of `app.js`. It has no DOM access, so the same functions can sit behind Highcharts, D3 or any other renderer.

- **`rebalance(values, locked, index, newValue, total)`** sets one period, then spreads the difference across the other unlocked periods in proportion to their current values, which keeps the shape of the rest of the curve. Locked periods never change.
- **`distribute(...)`** does the spreading. If a period would go below zero it is pinned at zero, removed from the pool, and the leftover is spread again over the rest.
- **`brush(...)`** moves nearby periods with a Gaussian falloff (the "drag the curve" gesture); periods outside the brush absorb the change.
- **`applyPreset(...)`** fills the unlocked periods with a shape, scaled to whatever budget the locked periods leave. The S-curve is a logistic cumulative curve converted to per-period increments.
- **`resampleStroke(...)` / `applyStroke(...)`** sample a freehand stroke at each period centre (interpolating gaps), then fit it to the total around any locks. A partial stroke reshapes only the months it covers and the rest rebalances.
- **`roundToTotal(...)`** rounds with the largest-remainder method, so the displayed values always add up to the total exactly.

Monthly values are the only stored series. Quarterly figures are always derived from them, so there is never a second copy to reconcile.
