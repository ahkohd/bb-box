# 104: A card nvidia-smi did not read is not known yet, and blocks only itself

Status: accepted, 15 November 2026. Supersedes [071](071-gpu-boxes.md)'s rule for incomplete readings, in its [results](071-results.md#unit-5-claims-and-the-helpers-writes-on).

## Context

The GPU helper, `bb-box-gpu`, reads the host's cards with one `nvidia-smi -l 1` that it keeps running. It took each tick's rows as one reading, and ended a reading early once it had as many rows as the reading before.

On a host with two cards and persistence mode off, the rows of one tick sometimes came more than a quarter of a second apart. The helper then took the first row alone as a reading of one card. From then on every reading ended after one row, so every pass saw one card, for as long as the service ran. Full ticks did not put it right.

071 made a reading that leaves a card out decide nothing on that card, and a reading with a row it cannot read, or a query that did not exit with status 0, decide nothing on any card. Every start of a box with a card also needed a full reading of every card. So on that host:

- every start of a GPU box was refused `no-cards`, 217 times in 13 hours, including starts on the card that read every time;
- the report's error line, naming the card left out, stayed;
- the report listed one card, so the doctor's "Markers on GPU guests" check failed the guests on the other card for naming nodes no card has.

Run by hand, `nvidia-smi` read both cards in 0.03 s.

## Decision

- The helper keeps each card's last row from `nvidia-smi`, and uses it for up to 10 s, as it did the whole reading before. A tick that leaves a card out, or whose rows come late, changes no card's state. A reading never shrinks to the cards of one partial tick.
- A card `nvidia-smi` did not read is not known yet. That blocks decisions on that card alone. A card it read is decided as on a full reading, whatever happened to another card.
- A row the helper cannot read, or a query that did not exit with status 0, makes the cards it did not read not known yet. The rows it read stand.
- Only a row `nvidia-smi` finished counts. A last line its output ends partway through, with no newline, is no row, and a row whose free memory is above its total, or whose total is 0, is one the helper cannot read. Either leaves that card not known yet.
- A start on a card the helper has not read waits. The helper tries it again each pass, and starts it once the card is read. After 60 s it refuses it `card-unread`, naming the card's PCI address, or `no-cards` when `nvidia-smi` read no card at all. bb-box waits 120 s for an answer, so it sees the refusal. The wait is kept in the ledger, so it survives a restart of the helper.
- Once bb-box has sent Proxmox the write that puts its request on the box, it counts the request as placed, whatever becomes of the write's answer. When it stops waiting, because the start was cancelled, the write's answer was lost or 120 s passed, it takes the request off the box, with 10 s of its own to do so, so the helper never starts the box later. If it cannot take the request off, it says the helper may still start the box.
- The helper acts on a request only while it is still on the box: it reads the guest again under its config lock just before it acts, and refuses a request whose tag has gone as `withdrawn`. It cannot tell on its own that bb-box gave up while the tag stays, as the tag carries no deadline. That would change the request's form, which older helpers and bb-box read, so it is left for a later protocol.
- A claim on a card the helper has not read waits, as before.
- No guest's lines for a card the helper has not read are changed, and no guest's lines are put right, as at boot or after a write cut short, until a full reading. A lost ledger is rebuilt only from a full reading, as before. A reading that is not full is still an error line, and still fails `--preview` and `setup-gpu.sh --writes on`.
- The report names each card the driver lists that `nvidia-smi` did not read: `unread <uuid> pci <address> minor <n> drm <card> <render>`. Its UUID comes from the driver, or else from the last full reading. The doctor's "Markers on GPU guests" check counts these cards' nodes as a card's.
- A start beside a card whose device nodes the helper cannot find is refused `card-nodes`, not `no-cards`.

## Consequences

- A card left out for a moment no longer stops boxes on the other cards. A card left out for longer than 10 s stops only its own boxes, for up to a minute each.
- A reading 071 counted as incomplete for every card now decides the cards it read. A row `nvidia-smi` printed in full, ending in a newline, is trusted even when it then failed. Its UUID and PCI address are what the helper decides on, and the device nodes come from the driver.
- A card that falls off the bus is still listed for up to 10 s, as it was when the whole reading was kept for 10 s.
- An older bb-box shows `card-unread` as "the helper's reason was card-unread".
- The helper is version 0.4.4. Its protocol is still 1: the ledger's new `waiting` entries are ignored by an older helper.
