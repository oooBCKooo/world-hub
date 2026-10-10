import hashlib
def statistics(text):
    if not isinstance(text, str):
        raise ValueError('INPUT_INVALID')
    raw = text.encode('utf-8', 'strict')
    if len(raw) > 16384:
        raise ValueError('INPUT_INVALID')
    return {'codePoints': len(text), 'lines': text.count('\n') + 1, 'utf8Bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
