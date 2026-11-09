# Files first-draw measurements

Measured on 9 November 2026, in a Linux container on an AMD Ryzen Threadripper PRO 9975WX, Ubuntu 24.04.5, kernel 6.17.13 and Node 24.21.0.

## Method

The same home contains exactly 200,000 files: 100 directories of 1,000 files under `visible`, and the same under `.cache`. Each file holds eight bytes. The baseline was measured before implementation. Both versions invoke the actual panel RPC handlers, inherited `Boxes.runOwn`, its command wrapper, and the repository's `CommandLine` adapter running `/bin/sh` locally. Only box lookup and transport selection point at the local fixture. Filesystem operations are real.

These are local handler timings from just before invocation until the returned promise resolves. They exclude network transport and browser paint. The baseline first tree includes its sequential home and recursive names calls. The new first tree includes one shallow home call. Cold means a fresh plugin cache in a fresh Node process, not a flushed operating-system page cache. Warm means the same process and fixture after that first call. Reopen uses the same plugin cache again. No operating-system cache was flushed. Values are individual observations, not percentiles.

## Results

| Operation | Baseline cold | New cold | Baseline warm | New warm | Baseline reopen | New reopen |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First tree, ms | 20,048.69 | 28.35 | 8.46 | 0.024 | 9.09 | 0.031 |
| Shell commands for first tree | 2 | 1 | 1 | 0 | 1 | 0 |
| Isolated 1,000-entry directory read, ms | 2,799.57 | 10.62 | 2,861.16 | 10.71 | 2,723.12 | 9.64 |
| Background capped name index, ms | See below | 39.65 | See below | 34.72 | See below | 32.00 |

Baseline UI expansion issued zero RPCs because the recursive tree had already loaded. Its isolated `files.list` timing above is a diagnostic, not a baseline UI expansion delay. The new expansion issues a shallow call; an already cached expansion can return before its separate refresh. The new directory timings above force that refresh, so they measure the real shell work rather than cache lookup.

The baseline name walk reached its 20-second shell timeout with only 13,344 file paths returned. It incorrectly labelled that partial response complete, then reused it in warm and reopen calls. Its quick-open data became available with that incomplete first tree; there was no additional UI RPC. Warm baseline speed therefore does not imply a complete index.

The new background index returns 19,979 file paths and 21 directory paths, explicitly capped at 20,000 names. This is **capped index ready**, not a full corpus. Hidden directories are pruned before walking. Index latency starts at its handler invocation after first draw and is not included in the first-tree value. It is not a measurement of browser scheduling between the two calls.

The completion marker, timeout handling and partial flag prevent an interrupted walk from masquerading as complete. Unreadable descendants retain readable records and report a partial index.

## Verification boundaries

Real sh, dash and BusyBox runs cover the shallow level, hidden pruning, newline omission, tab and backslash preservation and marker-like filenames. Tests cover the 8 MB LRU, cache separation, cached reopen, delayed refreshes, loading bars and a still refresh icon. Individual rule reversions were observed to fail, then restored. Screenshots use the real Workspace and theme with the host's published Hugeicons mappings in a local preview runtime, at 1440 and 390 px in both themes.

Under the real CommandLine adapter, strace showed that the BusyBox fallback initially still read all 100 visible directories after awk reached its cap. Explicitly terminating the recorded producer reduced this to 56 directories; stat batches read ahead. The script unlinks its FIFO after both endpoints open, before the long walk, and reaps only its recorded producer.

PowerShell 7.6.9 on Linux parsed all four generated depth and hidden-setting variants, including a quoted Windows path. This is syntax validation, not Windows backend execution. Real Windows execution and macOS awk remain platform verification limits.

Final validation passed: type checking, 3,780 Node tests and 526 UI tests. The Node suite skipped 335 platform or live-service cases. Eleven revert experiments failed as expected and were restored. Final timings were taken after the full suite ended.
