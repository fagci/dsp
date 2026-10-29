# Tables and records

Many modules (decoders, scanners, phone sensors) emit **records** — small objects like `{proto:'ble', src:'aa:bb', rssi:-60}` — on a `rec` pin. Other modules turn them into something you can see.

## Table
**Table** (in *Data*) keeps records as rows. Wire a `rec` pin into it: every record becomes a row (or updates one, if you set a **key** column). The Table filters, sorts, calculates columns (including `lookup()` into reference lists such as MAC vendors) and can save to CSV. Its **`rows`** output hands the whole set to viewers.

## Viewers
- **Graph** — rows with `from` and `to` become links; rows with an `id` become nodes. Node columns: `label`, `group`, `color`, `shape`, `image`, `glyph`, `note`, `size`. Link columns: `weight`, `label`, `color`, `dashes`, `arrows`. Click a node to edit it; changes can go back to the Table through the `edit` output.
- **Map** — rows with `lat` and `lon` become points; link rows become lines.
- **Entity Card** — details of the node selected in a Graph.
- Rec Log, charts and other viewers take `rec` directly.

## Rec → Entities
Turns one decoder record into nodes and links by rules, so that a Wi-Fi scan or a BLE capture becomes a graph. Put a Table between it and a Graph to get colours, shapes and your own columns.

## More
The full description of Table, rows, rules and lookups is in the [README](../README.md) (sections *Table* and *Map and records*).
