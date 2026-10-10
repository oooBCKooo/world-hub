# Python reference provider

Run `python -B provider.py --config private-wiring.json`. Wiring follows the public provider contract, with `sdkDirectory` pointing to the public Python SDK and `contractPath` pointing to the machine contract. Private credentials belong to the deployment. Send `stop` on stdin for graceful shutdown.

This separately implemented reference uses the Python SDK directly. Its integration AI author had previously reviewed the JavaScript fixture; it is **not** evidence of a second independent docs-only author. The reference suite exercises exact contract results and failure envelopes. This implementation exits on transport failure and does not promise automatic reconnect, persistent deduplication, release, or arbitrary contract compatibility. Provider retention policy is unchanged; no messages are released.
