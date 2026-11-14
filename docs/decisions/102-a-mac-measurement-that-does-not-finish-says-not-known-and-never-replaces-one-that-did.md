# 102: A Mac measurement that does not finish says not known, and never replaces one that did

Status: accepted, 14 November 2026. Extends [065](065-macs-say-what-they-offer-and-ios-streams-in-software-where-they-must.md).

## Context

BB Box measures each Mac it starts on Namespace in the background, as soon as the box is claimed. The probe lists the iOS runtimes with `xcrun simctl list runtimes`, then runs a hardware H.264 check. On a Mac that has just started, the first list waits for the simulator service, for 4 to 20 seconds.

A box released within those seconds destroys its Mac while the probe runs. The transport hands back what the probe had printed: the chip, macOS and Xcode, and nothing after. The parser read the missing runtime list as an empty one, so it recorded "Xcode has no iOS runtime", and the hardware encoder as not measured. Namespace keeps one report for each kind of Mac, and the newest replaced the last. So one release seconds after ready took `ios` and shared iOS hosts away from every thread, until a later Mac of that kind was measured in full. The doctor also said "as it has no hardware H.264 encoder" when the encoder had not been measured.

Measured at the earliest point of boot, the probe answered in full. The slow first list did not give an empty answer by itself. See the [results](102-results.md).

## Decision

- The probe's last line says it finished. A probe without that line measured nothing: the Simulator and both encoders are not known, with that reason. This holds for the probe on every provider's Macs, as Tart, the SSH host pool and Namespace use the same probe.
- While Xcode lists no iOS runtime, or `simctl` fails, the probe lists them again, up to 5 times, 5 seconds apart. A list that fails every time makes the Simulator not known, with what `simctl` said. Xcode with no iOS runtime after that wait is still "no".
- While the hardware check gives no answer, such as when it crashes, the probe runs it again, up to 5 times, 5 seconds apart. VideoToolbox's refusal is an answer, and is not asked again.
- A measurement that is not conclusive never replaces one that is. For each of the Simulator, the hardware encoder and the software encoder, a "not known" keeps what was known. Where any is kept, the report keeps its earlier time, so it stays due and the Mac is measured again at the next chance. A conclusive "no" still replaces a "yes".
- On Namespace, a report that measured nothing and did not say its chip makes no kind of Mac.
- On Namespace, the `ios` offer comes from the newest kind of Mac that runs the iOS Simulator. A kind measured later that does not run it, or is not known to, does not take the offer away. With no such kind, the offer comes from the newest kind measured conclusively, then from the newest of all. The doctor still lists the newest first.
- On Namespace, a kind of Mac whose Simulator is not known is measured again. A Mac BB Box holds that it has not measured in full is measured at once. Where no kind makes an offer, BB Box starts a Mac for a few minutes to measure, at most once a day, as it does for a report from an older probe. It starts none while another kind makes the offer.
- The probe's version rises from 2 to 3, so a report an earlier probe saved, which may hold a "no" read from a probe cut short, is due at once. A Tart or pool Mac is measured again at the next chance. On Namespace, a report from an earlier probe that leaves no offer is measured again at the next maintenance, on a Mac BB Box starts if it holds none.
- Before the hardware encoder is measured, BB Box says video comes in software "until its hardware H.264 encoder is measured", not "as it has no hardware H.264 encoder".

## Consequences

- A Mac whose Xcode has no iOS runtime takes about 20 seconds longer to measure, and one whose hardware check never answers about 20 seconds more. A Mac that answers at once takes no longer.
- After the update, each Mac, and each kind of Namespace Mac that leaves no offer, is measured once more.
- A release while a Mac is measured costs nothing: the offer stays as the last whole measurement found it.
- A kind of Mac first measured by a probe that did not finish has no conclusive report. The doctor says it is not measured yet until a probe finishes, and the offer comes from another kind that runs the Simulator, where there is one.
