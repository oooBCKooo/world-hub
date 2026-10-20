import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { json, setup, okay, overview, preview, apply, rollbackPreview, moduleSource, importModule, stateFile } from '../../helpers/module-versions-scene.mjs';

const pythonProgram = version => `import argparse
import json
from pathlib import Path
import signal
import sys
import threading
from hub_bridge import Bridge, BridgeError

stopping = threading.Event()
ready = threading.Event()
output_lock = threading.Lock()
bridge = None

def emit(value):
    with output_lock:
        print(json.dumps(value, separators=(",", ":")), flush=True)

def stop(*unused):
    stopping.set()
    ready.clear()
    if bridge is not None:
        bridge.close()

def lifecycle():
    for line in sys.stdin:
        message = json.loads(line)
        if message.get("command") == "health":
            emit({"event": "module-health", "id": message["id"], "ready": ready.is_set() and not stopping.is_set()})
        if message.get("command") == "stop":
            stop()
            return
    stop()

parser = argparse.ArgumentParser()
parser.add_argument("--runtime-config", required=True)
config = json.loads(Path(parser.parse_args().runtime_config).read_text(encoding="utf-8"))
connection = config["bridges"][0]
topic = config["topics"]["events"]
bridge = Bridge(connection["endpoint"], connection["bridgeId"], credential=connection["credential"], token=connection["token"], timeout=3)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
threading.Thread(target=lifecycle, daemon=True).start()
try:
    welcome = bridge.connect().frame
    assert welcome["authenticated"] is True and welcome["principal"] == connection["principal"]
    bridge.send({"type": "register", "requestToken": "channels", "channels": [{"name": topic, "publish": True, "subscribe": True}]})
    registered = bridge.receive().frame
    assert registered["type"] == "registered" and registered["requestToken"] == "channels"
    bridge.send({"type": "subscribe", "token": "events", "filters": [topic], "from": "now"})
    subscribed = bridge.receive().frame
    assert subscribed["type"] == "subscribed" and subscribed["token"] == "events"
    bridge.send({"type": "publish", "requestToken": "version", "topic": topic, "body": {"member": config["componentId"], "version": "${version}", "runtime": "python"}})
    while not stopping.is_set():
        try:
            frame = bridge.receive(timeout=0.25).frame
        except TimeoutError:
            continue
        except BridgeError:
            if stopping.is_set():
                break
            raise
        if frame["type"] == "published" and frame.get("requestToken") == "version":
            ready.set()
            emit({"event": "module-ready"})
        elif frame["type"] == "delivery":
            emit({"event": "received", "body": frame.get("body")})
            bridge.send({"type": "ack", "subscription": subscribed["subscription"], "seq": frame["seq"]})
        elif frame["type"] in ("error", "denied"):
            raise RuntimeError("HUB_OPERATION_REFUSED")
finally:
    stop()
`;

test('management versions: a Node instance upgrades to a real Python bridge and rolls back to Node without changing identity or state', async t => {
  const scene = await setup(t), v1 = await moduleSource(scene, 'source', '1.0.0'), v2 = await moduleSource(scene, 'source', '2.0.0');
  const peer = await moduleSource(scene, 'peer', '1.0.0'); v2.manifest.runtime = { kind: 'python', entry: 'program.py' };
  await writeFile(join(v2.directory, 'module.json'), json(v2.manifest)); await writeFile(join(v2.directory, 'program.py'), pythonProgram('2.0.0'));
  await writeFile(join(v2.directory, 'requirements.txt'), 'websockets==15.0.1\n'); await copyFile(resolve('sdk/python/hub_bridge.py'), join(v2.directory, 'hub_bridge.py'));
  await importModule(scene, v1, 'original'); await importModule(scene, peer, 'peer');
  const local = scene.owner.localPrograms, identity = structuredClone(local.identities.get('original'));
  const state = await stateFile(scene, 'original', 'opaque state shared across selected runtime releases');
  okay(await scene.call('/manage/api/programs/peer/start', {})); okay(await scene.call('/manage/api/programs/original/start', {}));
  const peerHandle = local.handles.get('peer'); okay(await scene.call('/manage/api/programs/original/stop', {}));
  const review = await preview(scene, 'modules', 'original', v2.directory), updated = await apply(scene, 'modules', 'original', review);
  assert.equal(local.row('original').manifest.runtime.kind, 'python'); assert.deepEqual(Object.keys(local.row('original').environment), ['pythonPath']);
  okay(await scene.call('/manage/api/programs/original/start', {}));
  const saw = (version, offset = 0, runtime) => peerHandle.stdout.slice(offset).split('\n').some(line => { try {
    const event = JSON.parse(line); return event.event === 'received' && event.body.member === 'original' && event.body.version === version && (!runtime || event.body.runtime === runtime);
  } catch { return false; } });
  const deadline = Date.now() + 5000; while (!saw('2.0.0', 0, 'python') && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.ok(saw('2.0.0', 0, 'python'), peerHandle.stdout); assert.equal(local.row('original').communication, 'connected');
  assert.deepEqual(local.identities.get('original'), identity); assert.equal(await readFile(state, 'utf8'), 'opaque state shared across selected runtime releases');
  okay(await scene.call('/manage/api/programs/original/stop', {}));
  await apply(scene, 'modules', 'original', await rollbackPreview(scene, 'modules', 'original', updated.transactionId));
  assert.equal(local.row('original').manifest.runtime.kind, 'node'); assert.deepEqual(Object.keys(local.row('original').environment), ['nodePath']);
  const offset = peerHandle.stdout.length; okay(await scene.call('/manage/api/programs/original/start', {}));
  const rollbackDeadline = Date.now() + 5000; while (!saw('1.0.0', offset) && Date.now() < rollbackDeadline) await new Promise(done => setTimeout(done, 20));
  assert.ok(saw('1.0.0', offset), peerHandle.stdout.slice(offset)); assert.equal(local.handles.get('peer'), peerHandle); assert.equal(peerHandle.exit, null);
  assert.deepEqual(local.identities.get('original'), identity); assert.equal(await readFile(state, 'utf8'), 'opaque state shared across selected runtime releases');
  assert.equal(scene.hub.snapshot().bridges.length, 2); assert.equal((await overview(scene, 'modules', 'original')).history.length, 2);
});
