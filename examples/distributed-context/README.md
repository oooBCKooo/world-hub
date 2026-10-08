# 分布式上下文示例

系统提示词、对话历史和补充材料由三个独立程序提供。界面程序通过自己的 mod 请求信息、组合上下文，再交给独立 DSH harness 程序处理；结果也经 mod 返回，并由对话来源程序保存下一轮历史。示例中的角色、顺序、模型选择和业务状态都由外部程序管理。

枢纽只转交通讯，不组合提示词、不选择模型、不运行 harness。这个示例用于检验 mod 可连接不同来源和程序，不是随枢纽自动启动的业务。

## 显式选择现有 DSH

Node 22 可运行枢纽与普通集成测试。这个示例另需已有的 `@deepseek-ai/dsh` 安装，使用环境变量指定其包目录：

```powershell
$env:PEROS_DSH_ROOT = '<现有 @deepseek-ai/dsh 包目录>'
npm run demo:context
```

`demo:context` 在真实 DSH 进程中加载本地确定性测试模型，创建独立临时 home、workspace 和配置，并阻止该测试子进程访问网络。它不读取用户的 DSH home 或模型凭据，也不安装或更新全局 DSH。未配置或所选安装不可用时明确失败。

启动后终端输出界面地址和各程序 PID。Ctrl+C 停止此示例拥有的进程。需要运行这些应用集成测试时，保持上述环境变量，执行 `npm run test:dsh`；默认 `npm test` 不启动 DSH。

## 自行配置应用

`programs.config.json` 只含参考主题、示例身份及配置入口；`system-prompt.json`、`dialogue.json`、`context.txt` 都是人工编写的测试材料。`contextProviders` 可增减来源，每个来源选择自己的 mod、文件和状态目录。对应身份与权限写在此示例的 `hub.config.json`。

运行自选模型可使用 `node examples/distributed-context/run-phase2.mjs --config <程序配置文件>`，由程序配置自己的 provider、model、profile、home 与 cwd。相关程序和模型的运行条件由接入方安排。未知执行结果不会自动重试；等待结束、读取和 ACK 都不会释放枢纽保留的信息。
