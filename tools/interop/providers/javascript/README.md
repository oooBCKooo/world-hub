# JavaScript provider artifact

This is the unchanged `tests/fixtures/independent-provider/provider.mjs` from the earlier separate AI author experiment. `authorship.json` records its instruction-level material boundary and exact implementation digest; it is not a human third-party acceptance claim. The public reference suite runs this artifact beside a separately implemented Python reference, using one unchanged consumer and changing only wiring.

Run `node provider.mjs --config private-wiring.json` using the public provider wiring contract, `contractPath`, and `cursorFile`. Use IPC `stop` or a termination signal to close its bridge. Business logic is an optional demonstration outside Hub Core.
