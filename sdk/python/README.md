# Python mod 桥

本 SDK 采用仓库 [MIT 许可](../../LICENSE)。另行安装的 `websockets` 遵循自身许可，未作为本项目源码复制或重新许可。

`hub_bridge.py` 直接使用 Python `websockets` 的同步客户端连接 Hub，不转交 Node。安装桥依赖：

```powershell
python -m pip install -r sdk/python/requirements.txt
```

依赖固定为 `websockets==15.0.1`。库提供 `Bridge.connect()`、`send()`、`receive()`、`close()`；调用者将 `sdk/python` 加入自己的模块路径，或按自己的打包方式携带桥。Node 只用于仓库测试安排 Hub 和其他程序，不是使用 Python 桥的运行依赖。

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path('sdk/python').resolve()))
from hub_bridge import Bridge

bridge = Bridge('ws://127.0.0.1:8790/bridge', 'your-bridge', timeout=10)
try:
    welcome = bridge.connect()
    print(welcome.raw)
    bridge.send({'type': 'subscribe', 'token': 's1',
                 'filters': ['your/topic'], 'from': 0})
    received = bridge.receive(timeout=10)
    print(received.raw)
finally:
    bridge.close()
```

先在 Hub 配置登记自己的身份和主题权限。构造器接受 `credential`、`token`、有限正数 `timeout` 与 `max_frame_bytes`；token 留在调用者未跟踪的配置中。`send` 成功只表示本地发送完成，须自行核对真正的 Hub 回执。

接收值同时提供 `Frame.raw` 和 `Frame.frame`，原始 JSON 文本不根据诊断值重建。Python 诊断遇到超过 4000 位整数或不可表示的浮点时保留其数字文本，不缩小合法 raw 的范围。发送 Python dict 会重新序列化，非 JSON 常量被拒绝；若已有合法完整原文，应传字符串并自行安排通讯字段。

同一连接支持并发发送和接收，发送由有限锁串行；同一时刻只有一个 receive。有限超时、正常关闭和传输错误均有明确错误。桥不自动登记、订阅、ACK、release、重试、重连或持久化游标，也不判断程序业务。长期等待下一帧和应用总期限由调用者选择。

`tests/fixtures/python/worker.py` 是独立 NDJSON 测试程序，有额外回声业务；它与 `self_check.py` 都不是 SDK 接入形态要求。独立检查命令 `python tests/fixtures/python/self_check.py` 将每次报告写到新的 `.artifacts/evidence/python-self-check/` 子目录。跨语言集合与候选桥检查见[验证](../../docs/verification.md)。
