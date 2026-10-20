# Communicate through a hub bridge

Read this reference for SDK-based programs and transport diagnosis. Application contracts, payload schemas, completion semantics, idempotency, and state belong to the participating programs.

## Select the implementation

For an independent JavaScript ESM project:

```sh
npm install world-hub
```

```js
import { Bridge } from 'world-hub/bridge';
```

`world-hub` exports the same bridge entry point. `world-hub/blob` exports attachment helpers; `world-hub/lifecycle` exports the separate local managed-module lifecycle client. The Node bridge uses file APIs and cannot be imported directly into a browser.

Python and PowerShell bridges connect directly, without routing through a Node intermediary. The npm package includes `sdk/python/hub_bridge.py` and `sdk/powershell/HubBridge.psm1`; use their own documented interfaces. Python needs its declared `websockets==15.0.1` dependency; PowerShell needs PowerShell 7. Do not assume the Python and PowerShell SDKs implement every JavaScript convenience method. For an independent implementation, use the published wire protocol rather than guessing frames from JavaScript names.

## Identity and subscription barriers

The deployment supplies `url`, `bridgeId`, `credential`, `token`, expected principal, and topic permissions. `credential` identifies a registered credential; `token` is its secret when configured. A `bridgeId`, a stable principal, a per-connection session, and a local instance ID serve different purposes.

After `connect()`, check `welcome.principal` against the expected deployment identity. Require `welcome.authenticated === true` when authenticated operation is intended. A session changes on reconnect. A program may construct several bridges; isolate credentials, permissions, connection limits, and cursor state as its deployment requires.

Install delivery handlers before subscribing, then await `subscribe(...)` before advertising a service as available or issuing traffic that depends on that subscription. A subscription receipt proves establishment, not historical catch-up or business readiness. `caughtUp` is a transport observation.

Register only the concrete topics needed by the program:

```js
await bridge.registerChannels([
  { name: topic, publish: true, subscribe: true },
]);
```

Registration cannot enlarge the deployment ACL. Topic names are application/deployment choices; do not hardcode new domain categories in the Hub.

## Choose the operation

| JavaScript method | Meaning |
| --- | --- |
| `publishConfirmed(topic, body, options)` | Publish information and wait for Hub acceptance |
| `subscribe([filter], { from, operations })` | Receive retained and/or new matching deliveries |
| `requestTo({ principal, session? }, topic, body, options)` | Send a directed request; return its acceptance receipt |
| `respond(requestDelivery, body, options)` | Respond along the original request's return route |
| `call({ principal, session? }, topic, body, options)` | Establish its response subscription, send a request, and wait for the first matching response |
| `sendTo({ principal, session? }, topic, body, options)` | Inject directed information; acceptance does not prove the target acted |
| `ack(delivery)` | Acknowledge this subscription's received delivery |
| `release([seq], options)` | Release the current provider's own retained information |

Directed delivery contains `operation`, `fromPrincipal`, `senderSession`, `target`, and request/response linkage as applicable. Use these Hub-established fields when authorizing a request. `body.principal`, display names, headers, and author-supplied provider fields cannot replace that check.

`{ principal }` can address multiple allowed connections of one principal; the Hub does not elect a single business executor. Pin `{ principal, session }` only when that particular live connection is required. A future connection will not assume an old session's request.

## Bounded caller example

This example assumes the caller is registered and both participants have publish and subscribe permission on `topic`. `wiring` and `secretToken` come from the program's private deployment configuration, not from a public manifest or a received payload.

```js
import { Bridge } from 'world-hub/bridge';

const bridge = new Bridge({
  url: wiring.endpoint,
  bridgeId: wiring.bridgeId,
  credential: wiring.credential,
  token: secretToken,
});
bridge.on('error', event => console.error(event.code, event.message));
bridge.on('denied', event => console.error(event.code, event.message));
const deadline = setTimeout(() => { void bridge.close('caller deadline'); }, 10000);
try {
  const welcome = await bridge.connect();
  if (welcome.principal !== wiring.principal || welcome.authenticated !== true) {
    throw new Error('Unexpected or unauthenticated caller identity');
  }
  await bridge.registerChannels([
    { name: wiring.topic, publish: true, subscribe: true },
  ]);
  const result = await bridge.call(
    { principal: wiring.targetPrincipal }, wiring.topic,
    { text: 'Hello from an independent program' },
    { timeoutMs: 3000, receiptTimeoutMs: 2000 },
  );
  console.log('Hub accepted request', result.request.seq);
  console.log('Application response', result.response.body);
  // Interpret the response using the target application's public contract.
} finally {
  clearTimeout(deadline);
  await bridge.close();
}
```

The provider installs an operation/topic-filtered delivery handler, verifies `message.fromPrincipal`, validates its own input contract, performs its work, and awaits `bridge.respond(message, result)`. It then establishes its request subscription before announcing readiness. A complete runnable pair is in the SDK documentation linked below.

## Retention, retries, and cursors

`call` returns the first matching response, not every response from every instance. Use `requestTo` plus an explicit response subscription to collect multiple or delayed results. Keep its request receipt when reconciliation needs the original `seq`; a timed-out `call` does not promise to expose an already accepted request receipt.

`connect()` can wait through reconnections without an overall deadline. Set a task-appropriate total deadline and close when done. Acceptance timeout, local response timeout, or disconnection can occur after the Hub saved a message. The SDK does not cancel the business operation, replay the business request automatically, or release it on timeout.

Deliveries may repeat after replay, overlap, or reconnection. ACK and deduplication are distinct. With `autoAck: false`, ACK only after the program has durably handled the delivery according to its contract. ACK does not release the message. Historical information remains available according to the provider's retention policy and deployment capacity.

For JS subscriptions, numeric `from` means strictly after that sequence; `from: 'now'` uses the handshake's `welcome.lastSeq` snapshot; `from: 'resume'` uses saved progress or zero. `replay` intentionally replaces the matching subscription's initial reading position. It is not a request to re-execute business work.

Allocate cursor files per logical Hub deployment and bridge instance. `instanceId` is local cursor isolation, not authenticated identity. Multiple processes must not write the same cursor file; changing `instanceId` while still sharing an explicit file does not make writes safe.

## Attachments and on-demand modules

For large objects, use the attachment/blob protocol and `world-hub/blob` helpers instead of enlarging a JSON body or inventing a URL download convention. Verify size/digest and the actual transfer result. A message receipt and the receiver's completion of a file transfer are different observations.

`bridge.blobStatus(id)` observes an upload; `bridge.releaseBlob(id)` permits later capacity cleanup under its provider's policy. Neither confirms message consumption or immediately deletes bytes still referenced by retained information. In the MCP adapter, upload status, release and outgoing attachment IDs are further limited to that connection's recent own uploads; a received attachment remains a separate read authorization.

Ordinary messages and `Bridge.call` do not wake a stopped managed program. An authorized local caller uses the runtime-provided lifecycle descriptor and `callManaged`, or holds an explicit lifecycle lease until actual completion. A timeout or lost lease leaves the outcome unknown; do not declare completion to force idle shutdown. The manager controls owned processes; Hub Core does not execute message contents.

Use the CLI or the separately configured management MCP tools for deployment changes, as described in [management](management.md). Publishing a message that describes a command does not create management authority.

Authoritative details: [JavaScript SDK](https://github.com/oooBCKooo/world-hub/blob/main/sdk/javascript/README.md), [Python SDK](https://github.com/oooBCKooo/world-hub/blob/main/sdk/python/README.md), [PowerShell SDK](https://github.com/oooBCKooo/world-hub/blob/main/sdk/powershell/README.md), [wire protocol](https://github.com/oooBCKooo/world-hub/blob/main/docs/specs/protocol.md), [directed calls and attachments](https://github.com/oooBCKooo/world-hub/blob/main/docs/specs/directed-and-bulk.md), and [managed lifecycle client](https://github.com/oooBCKooo/world-hub/blob/main/sdk/javascript/LIFECYCLE.md).
