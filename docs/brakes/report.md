# Anti-snowball sweep — largest-civ share of settled land

10 headless engine runs (no agents; research on the engine's unsteered fallback), each 3000 sim-years from its own seed. "Settled land" is every land cell owned by any civilisation (19,741 land cells exist worldwide). Deterministic: re-running a seed reproduces its row exactly.

## Verdict

- Largest-civ share, distribution: min 0.279, median 0.339, max 0.379
- Runs where one civ held > 60% of settled land: **0 of 10**
- Runs where one civ held > 80%: **0 of 10**

## Runs

| Seed | Largest share | Shares (all civs) | Plagues | Unrest | Secessions | Depletions | Degradations | Famines | Extinct | Runtime |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **27.9%** (civ 1) | 0:28% 1:28% 2:25% 3:2% 4:18% | 427 | 1641 | 1450 | 26 | 1504 | 0 | — | 25.7s |
| 2 | **36.5%** (civ 1) | 0:22% 1:37% 2:26% 3:3% 4:14% | 323 | 2257 | 1947 | 25 | 1818 | 0 | — | 26.2s |
| 3 | **29.9%** (civ 0) | 0:30% 1:29% 2:19% 3:2% 4:19% | 390 | 1724 | 1525 | 26 | 1498 | 2 | — | 27.4s |
| 4 | **32.4%** (civ 1) | 0:28% 1:32% 2:18% 3:2% 4:20% | 412 | 1930 | 1754 | 26 | 1692 | 1 | — | 24.2s |
| 5 | **33.9%** (civ 1) | 0:15% 1:34% 2:20% 3:2% 4:29% | 362 | 1815 | 1690 | 25 | 1528 | 0 | — | 23.1s |
| 6 | **35.1%** (civ 1) | 0:33% 1:35% 2:28% 3:2% 4:1% | 368 | 1923 | 1753 | 25 | 1672 | 0 | — | 22.1s |
| 7 | **37.9%** (civ 1) | 0:24% 1:38% 2:20% 3:3% 4:16% | 398 | 2273 | 2074 | 25 | 2038 | 1 | — | 25.4s |
| 8 | **35.4%** (civ 1) | 0:18% 1:35% 2:20% 3:2% 4:25% | 395 | 1997 | 1776 | 25 | 1704 | 1 | — | 24.3s |
| 9 | **33.4%** (civ 1) | 0:17% 1:33% 2:23% 3:2% 4:25% | 402 | 1902 | 1765 | 25 | 1762 | 1 | — | 25.2s |
| 10 | **32.8%** (civ 1) | 0:20% 1:33% 2:28% 3:2% 4:17% | 404 | 2115 | 1940 | 25 | 1881 | 0 | — | 26.1s |

## The brakes on each run's leader

Brake events recorded *against the run's final largest civ* — the log's answer to "what pushed back on the winner":

- seed 1, civ 1 at 27.9%: plague 109 · unrest 44 · secession 7 · depletion 6 · degradation 59
- seed 2, civ 1 at 36.5%: plague 100 · unrest 645 · secession 448 · depletion 6 · degradation 516
- seed 3, civ 0 at 29.9%: plague 125 · unrest 461 · secession 417 · depletion 14 · degradation 402
- seed 4, civ 1 at 32.4%: plague 125 · unrest 19 · secession 2 · depletion 6 · degradation 54
- seed 5, civ 1 at 33.9%: plague 102 · unrest 182 · secession 140 · depletion 5 · degradation 192
- seed 6, civ 1 at 35.1%: plague 123 · unrest 6 · secession 6 · depletion 6 · degradation 62
- seed 7, civ 1 at 37.9%: plague 103 · unrest 375 · secession 283 · depletion 6 · degradation 360
- seed 8, civ 1 at 35.4%: plague 133 · unrest 15 · secession 9 · depletion 6 · degradation 61
- seed 9, civ 1 at 33.4%: plague 101 · unrest 26 · secession 10 · depletion 6 · degradation 66
- seed 10, civ 1 at 32.8%: plague 130 · unrest 168 · secession 132 · depletion 5 · degradation 179

## Largest-share trajectory (every 250 years)

- seed 1: 250:22% → 500:57% → 750:47% → 1000:40% → 1250:33% → 1500:34% → 1750:31% → 2000:29% → 2250:33% → 2500:30% → 2750:28% → 3000:28%
- seed 2: 250:22% → 500:57% → 750:43% → 1000:33% → 1250:40% → 1500:42% → 1750:41% → 2000:36% → 2250:36% → 2500:36% → 2750:39% → 3000:37%
- seed 3: 250:22% → 500:47% → 750:42% → 1000:39% → 1250:37% → 1500:28% → 1750:30% → 2000:29% → 2250:27% → 2500:28% → 2750:29% → 3000:30%
- seed 4: 250:22% → 500:57% → 750:43% → 1000:38% → 1250:32% → 1500:33% → 1750:31% → 2000:31% → 2250:32% → 2500:31% → 2750:36% → 3000:32%
- seed 5: 250:22% → 500:54% → 750:46% → 1000:43% → 1250:34% → 1500:32% → 1750:32% → 2000:31% → 2250:32% → 2500:32% → 2750:32% → 3000:34%
- seed 6: 250:22% → 500:56% → 750:48% → 1000:46% → 1250:35% → 1500:40% → 1750:37% → 2000:41% → 2250:40% → 2500:38% → 2750:36% → 3000:35%
- seed 7: 250:22% → 500:50% → 750:38% → 1000:41% → 1250:34% → 1500:29% → 1750:31% → 2000:29% → 2250:31% → 2500:35% → 2750:38% → 3000:38%
- seed 8: 250:22% → 500:57% → 750:47% → 1000:36% → 1250:31% → 1500:32% → 1750:36% → 2000:33% → 2250:29% → 2500:33% → 2750:33% → 3000:35%
- seed 9: 250:22% → 500:55% → 750:39% → 1000:38% → 1250:33% → 1500:30% → 1750:31% → 2000:29% → 2250:32% → 2500:30% → 2750:30% → 3000:33%
- seed 10: 250:22% → 500:56% → 750:40% → 1000:34% → 1250:31% → 1500:33% → 1750:35% → 2000:33% → 2250:32% → 2500:32% → 2750:32% → 3000:33%

## Receipts — heaviest brake events

### Seed 1
- Year 194 · plague (weight 0.94, civ 0): A plague swept through Band of aquitaine.
- Year 336 · plague (weight 0.92, civ 4): A plague swept through Band of honshu.
- Year 524 · plague (weight 0.91, civ 0): A plague swept through Band of aquitaine.
- Year 613 · plague (weight 0.86, civ 0): A plague swept through Band of aquitaine.
- Year 1039 · plague (weight 0.85, civ 4): A plague swept through Band of honshu.
- Year 376 · plague (weight 0.84, civ 4): A plague swept through Band of honshu.
- Year 282 · plague (weight 0.78, civ 0): A plague swept through Band of aquitaine.
- Year 531 · plague (weight 0.76, civ 3): A plague swept through Band of deccan.

### Seed 2
- Year 493 · plague (weight 0.85, civ 3): A plague swept through Band of deccan.
- Year 402 · plague (weight 0.82, civ 0): A plague swept through Band of aquitaine.
- Year 23 · plague (weight 0.79, civ 2): A plague swept through Band of zambezi.
- Year 274 · plague (weight 0.75, civ 3): A plague swept through Band of deccan.
- Year 2662 · plague (weight 0.74, civ 3): A plague swept through Band of deccan.
- Year 2039 · plague (weight 0.72, civ 3): A plague swept through Band of deccan.
- Year 999 · plague (weight 0.70, civ 1): A plague swept through Band of greatlakes.
- Year 1198 · plague (weight 0.69, civ 0): A plague swept through Band of aquitaine.

### Seed 3
- Year 312 · plague (weight 0.90, civ 1): A plague swept through Band of greatlakes.
- Year 101 · plague (weight 0.88, civ 3): A plague swept through Band of deccan.
- Year 509 · plague (weight 0.88, civ 2): A plague swept through Band of zambezi.
- Year 370 · plague (weight 0.87, civ 1): A plague swept through Band of greatlakes.
- Year 270 · plague (weight 0.81, civ 4): A plague swept through Band of honshu.
- Year 333 · plague (weight 0.72, civ 3): A plague swept through Band of deccan.
- Year 1453 · plague (weight 0.71, civ 2): A plague swept through Band of zambezi.
- Year 1629 · plague (weight 0.71, civ 3): A plague swept through Band of deccan.

### Seed 4
- Year 198 · plague (weight 0.92, civ 4): A plague swept through Band of honshu.
- Year 416 · plague (weight 0.85, civ 1): A plague swept through Band of greatlakes.
- Year 1056 · plague (weight 0.82, civ 4): A plague swept through Band of honshu.
- Year 372 · plague (weight 0.81, civ 4): A plague swept through Band of honshu.
- Year 630 · plague (weight 0.79, civ 0): A plague swept through Band of aquitaine.
- Year 44 · plague (weight 0.76, civ 1): A plague swept through Band of greatlakes.
- Year 2831 · plague (weight 0.76, civ 3): A plague swept through Band of deccan.
- Year 1967 · plague (weight 0.74, civ 3): A plague swept through Band of deccan.

### Seed 5
- Year 440 · plague (weight 0.92, civ 0): A plague swept through Band of aquitaine.
- Year 535 · plague (weight 0.92, civ 3): A plague swept through Band of deccan.
- Year 61 · plague (weight 0.88, civ 0): A plague swept through Band of aquitaine.
- Year 337 · plague (weight 0.85, civ 1): A plague swept through Band of greatlakes.
- Year 225 · plague (weight 0.84, civ 3): A plague swept through Band of deccan.
- Year 2967 · plague (weight 0.84, civ 3): A plague swept through Band of deccan.
- Year 793 · plague (weight 0.84, civ 3): A plague swept through Band of deccan.
- Year 1641 · plague (weight 0.78, civ 3): A plague swept through Band of deccan.

### Seed 6
- Year 400 · plague (weight 0.89, civ 2): A plague swept through Band of zambezi.
- Year 692 · plague (weight 0.88, civ 4): A plague swept through Band of honshu.
- Year 467 · plague (weight 0.88, civ 0): A plague swept through Band of aquitaine.
- Year 549 · plague (weight 0.87, civ 2): A plague swept through Band of zambezi.
- Year 920 · plague (weight 0.83, civ 3): A plague swept through Band of deccan.
- Year 103 · plague (weight 0.82, civ 1): A plague swept through Band of greatlakes.
- Year 1224 · plague (weight 0.80, civ 4): A plague swept through Band of honshu.
- Year 2647 · plague (weight 0.80, civ 3): A plague swept through Band of deccan.

### Seed 7
- Year 388 · plague (weight 0.93, civ 4): A plague swept through Band of honshu.
- Year 377 · plague (weight 0.89, civ 1): A plague swept through Band of greatlakes.
- Year 2186 · plague (weight 0.81, civ 3): A plague swept through Band of deccan.
- Year 927 · plague (weight 0.79, civ 3): A plague swept through Band of deccan.
- Year 302 · plague (weight 0.78, civ 3): A plague swept through Band of deccan.
- Year 453 · plague (weight 0.76, civ 4): A plague swept through Band of honshu.
- Year 1516 · plague (weight 0.70, civ 4): A plague swept through Band of honshu.
- Year 2602 · plague (weight 0.70, civ 0): A plague swept through Band of aquitaine.

### Seed 8
- Year 1039 · plague (weight 0.85, civ 3): A plague swept through Band of deccan.
- Year 1009 · plague (weight 0.85, civ 4): A plague swept through Band of honshu.
- Year 33 · plague (weight 0.84, civ 4): A plague swept through Band of honshu.
- Year 2120 · plague (weight 0.82, civ 3): A plague swept through Band of deccan.
- Year 1184 · plague (weight 0.78, civ 3): A plague swept through Band of deccan.
- Year 58 · plague (weight 0.75, civ 0): A plague swept through Band of aquitaine.
- Year 315 · plague (weight 0.75, civ 1): A plague swept through Band of greatlakes.
- Year 2046 · plague (weight 0.72, civ 2): A plague swept through Band of zambezi.

### Seed 9
- Year 424 · plague (weight 0.88, civ 4): A plague swept through Band of honshu.
- Year 415 · plague (weight 0.88, civ 1): A plague swept through Band of greatlakes.
- Year 1820 · plague (weight 0.87, civ 3): A plague swept through Band of deccan.
- Year 2506 · plague (weight 0.87, civ 3): A plague swept through Band of deccan.
- Year 263 · plague (weight 0.84, civ 2): A plague swept through Band of zambezi.
- Year 2402 · plague (weight 0.83, civ 3): A plague swept through Band of deccan.
- Year 833 · plague (weight 0.81, civ 4): A plague swept through Band of honshu.
- Year 251 · plague (weight 0.78, civ 2): A plague swept through Band of zambezi.

### Seed 10
- Year 172 · plague (weight 0.93, civ 1): A plague swept through Band of greatlakes.
- Year 1045 · plague (weight 0.87, civ 4): A plague swept through Band of honshu.
- Year 441 · plague (weight 0.85, civ 2): A plague swept through Band of zambezi.
- Year 539 · plague (weight 0.84, civ 4): A plague swept through Band of honshu.
- Year 1015 · plague (weight 0.78, civ 3): A plague swept through Band of deccan.
- Year 629 · plague (weight 0.77, civ 0): A plague swept through Band of aquitaine.
- Year 2639 · plague (weight 0.75, civ 3): A plague swept through Band of deccan.
- Year 2123 · plague (weight 0.72, civ 3): A plague swept through Band of deccan.
