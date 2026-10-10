"""Optional public text.statistics benchmark provider, using the Python bridge.

Reference implementation by the integration AI; this author also reviewed the
JavaScript fixture. It is not an independent docs-only author experiment.
"""
import argparse
import hashlib
import json
from pathlib import Path
import signal
import sys
import threading
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--config', required=True)
args = parser.parse_args()
config_path = Path(args.config).resolve()
config = json.loads(config_path.read_text(encoding='utf-8'))
local = lambda value: (config_path.parent / value).resolve()
sys.path.insert(0, str(local(config['sdkDirectory'])))
from hub_bridge import Bridge, BridgeError

contract = json.loads(local(config['contractPath']).read_text(encoding='utf-8'))
expected_contract = {'id': 'text.statistics', 'version': '1.0.0'}
if contract['contract'] != expected_contract:
    raise ValueError('Unsupported reference contract')
stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())
def stdin_control():
    for line in sys.stdin:
        if line.strip() == 'stop':
            stop.set()
            break
threading.Thread(target=stdin_control, daemon=True).start()

bridge = Bridge(config['endpoint'], config['bridgeId'], credential=config.get('credential'), token=config['token'], timeout=5)
pending_acks = {}
def token():
    return str(uuid.uuid4())
def failure(body, code):
    invocation = body.get('invocationId', '') if isinstance(body, dict) else ''
    if not isinstance(invocation, str) or len(invocation) > 256:
        invocation = ''
    return {'ok': False, 'kind': 'demo.capability-result', 'contract': expected_contract,
            'invocationId': invocation, 'status': 'failed', 'provider': config['moduleId'],
            'error': {'code': code, 'message': code, 'retryable': False}}
def business(frame):
    body = frame.get('body')
    if frame.get('fromPrincipal') not in config['allowedCallers']:
        return failure(body, 'PERMISSION_DENIED')
    if not isinstance(body, dict) or not isinstance(body.get('contract'), dict) or body['contract'].get('id') != expected_contract['id'] or body['contract'].get('version') != expected_contract['version']:
        return failure(body, 'CONTRACT_MISMATCH')
    if set(body) != {'contract', 'invocationId', 'text'} or set(body['contract']) != {'id', 'version'}:
        return failure(body, 'INPUT_INVALID')
    invocation, text = body['invocationId'], body['text']
    if not isinstance(invocation, str) or not 1 <= len(invocation) <= 256 or not isinstance(text, str):
        return failure(body, 'INPUT_INVALID')
    try:
        encoded = text.encode('utf-8', errors='strict')
    except UnicodeEncodeError:
        return failure(body, 'INPUT_INVALID')
    if len(encoded) > 16384:
        return failure(body, 'INPUT_INVALID')
    return {'ok': True, 'kind': 'demo.capability-result', 'contract': expected_contract,
            'invocationId': invocation, 'status': 'completed', 'provider': config['moduleId'],
            'executionId': str(uuid.uuid4()), 'output': {'codePoints': len(text), 'lines': text.count('\n') + 1,
            'utf8Bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest()}}
def receive(timeout=0.2):
    frame = bridge.receive(timeout=timeout).frame
    if frame.get('type') == 'delivery' and frame.get('operation') == 'request' and frame.get('topic') == config['businessTopic']:
        request_token = token()
        bridge.send({'type': 'respond', 'requestToken': request_token, 'requestSeq': frame['seq'], 'body': business(frame)})
        pending_acks[request_token] = (frame['subscription'], frame['seq'])
    elif frame.get('type') == 'published' and frame.get('requestToken') in pending_acks:
        subscription, seq = pending_acks.pop(frame['requestToken'])
        bridge.send({'type': 'ack', 'subscription': subscription, 'seq': [seq]})
    return frame
def wait(predicate, deadline=5):
    end = time.monotonic() + deadline
    while not stop.is_set() and time.monotonic() < end:
        try:
            frame = receive(min(0.2, max(0.01, end - time.monotonic())))
            if predicate(frame):
                return frame
            if frame.get('type') in ('error', 'denied'):
                raise RuntimeError(frame.get('code', 'HUB_REJECTED'))
        except TimeoutError:
            pass
    raise TimeoutError('Finite protocol wait expired')

try:
    welcome = bridge.connect().frame
    if welcome.get('authenticated') is not True or welcome.get('principal') != config['principal'] or 'directed-v1' not in welcome.get('features', []):
        raise RuntimeError('Authenticated directed bridge required')
    register_topic = config['directory']['registerTopic']
    request_token = token()
    bridge.send({'type': 'register', 'requestToken': request_token, 'channels': [
        {'name': topic, 'publish': True, 'subscribe': True} for topic in [config['businessTopic'], register_topic]]})
    wait(lambda f: f.get('type') == 'registered' and f.get('requestToken') == request_token)
    for topic, operations in [(config['businessTopic'], ['request']), (register_topic, ['response'])]:
        sub_token = token()
        bridge.send({'type': 'subscribe', 'token': sub_token, 'filters': [topic], 'operations': operations,
                     'delivery': 'bounded_ack', 'from': welcome['lastSeq']})
        wait(lambda f: f.get('type') == 'subscribed' and f.get('token') == sub_token)
    manifest = {'manifestVersion': 1, 'module': {'id': config['moduleId'], 'version': config['moduleVersion']},
                'capabilities': [{key: contract[key] for key in ['contract', 'inputSchema', 'outputSchema', 'semantics', 'effects', 'permissions']}],
                'leaseMs': config['leaseMs']}
    manifest['capabilities'][0].update(id=expected_contract['id'], topic=config['businessTopic'])
    def register():
        request_token = token()
        bridge.send({'type': 'request', 'requestToken': request_token, 'target': {'principal': config['directory']['principal']}, 'topic': register_topic, 'body': manifest})
        receipt = wait(lambda f: f.get('type') == 'published' and f.get('requestToken') == request_token)
        reply = wait(lambda f: f.get('type') == 'delivery' and f.get('operation') == 'response' and f.get('requestSeq') == receipt['seq'] and f.get('fromPrincipal') == config['directory']['principal'])
        body = reply['body']
        entry = body.get('entry', {})
        if body.get('ok') is not True or body.get('kind') != 'demo.capability-registration' or entry.get('principal') != config['principal'] or entry.get('session') != welcome['session'] or entry.get('module') != manifest['module'] or entry.get('capabilities') != manifest['capabilities']:
            raise RuntimeError('Directory registration rejected or mismatched')
        bridge.send({'type': 'ack', 'subscription': reply['subscription'], 'seq': [reply['seq']]})
    register()
    print(json.dumps({'event': 'ready', 'type': 'ready', 'principal': welcome['principal'], 'session': welcome['session'], 'moduleId': config['moduleId']}), flush=True)
    next_register = time.monotonic() + config['renewEveryMs'] / 1000
    while not stop.is_set():
        if time.monotonic() >= next_register:
            register()
            next_register = time.monotonic() + config['renewEveryMs'] / 1000
        try:
            receive()
        except TimeoutError:
            pass
finally:
    bridge.close()
