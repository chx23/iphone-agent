# phone-agent

Headless phone agent for Codex/current-window tasks, powered by the KuaiJS
project runtime.

The project only maintains the phone-control CLI. It does not ship an Electron
desktop app, desktop packaging, or any in-repo recurring-run implementation.
Recurring runs should be configured in codex.app Automations, with the
automation invoking the CLI command for the desired task.

## Run From The Current Window

```powershell
npm install
npm run agent:run -- --health
npm run agent:run -- --smoke
npm run agent:run -- --task="打开微信"
```

Natural-language tasks use the same agent state machine:

```powershell
npm run agent:run -- --task="打开机械之心公众号，阅读最新文章并总结"
npm run agent:run -- --task="上大众点评搜索附近美食"
```

Useful environment variables:

```powershell
$env:PHONE_AGENT_DEVICE_URL="http://127.0.0.1:59844"
$env:AI_API_URL="https://llmapi.paratera.com/v1/chat/completions"
$env:AI_API_KEY="..."
$env:LANGUAGE_MODEL="GLM-5-Turbo"
$env:VISION_API_URL="https://llmapi.paratera.com/v1/chat/completions"
$env:VISION_API_KEY="..."
$env:VISION_MODEL="Qwen3-VL-235B-A22B-Instruct"
$env:PHONE_AGENT_TRUSTED_CONTACTS="陈弘轩"
```

For local defaults, put the same key-value lines in either `.env.local` at the
workspace root or `%APPDATA%\phone-agent\local.env`. These files are local
private config and should not be committed.

Use `PHONE_AGENT_AUTO_CONFIRM=1` only inside trusted codex.app automations.

## Codex Automations

Set the automation in codex.app, not in this repository. Point the automation at
this workspace and run the CLI directly, for example:

```powershell
npm --prefix E:\phone-agent run agent:run -- --task="打开机械之心公众号，阅读最新文章并总结后发给陈弘轩"
```

For unattended sends, set `PHONE_AGENT_TRUSTED_CONTACTS` and
`PHONE_AGENT_AUTO_CONFIRM=1` in the automation environment only after you have
verified the flow manually.

## Low-Level Actions

For diagnosis or Codex-controlled primitives:

```powershell
npm run agent:run -- --action-json='{"type":"home"}'
npm run agent:run -- --action-json='{"type":"open_app","bundleId":"com.tencent.xin","displayName":"微信"}'
```

PowerShell-friendly shortcuts:

```powershell
npm run agent:run -- --home
npm run agent:run -- --back
npm run agent:run -- --open-app 微信
npm run agent:run -- --tap 500,1200
npm run agent:run -- --input "测试文本"
```

App launching follows the KuaiJS runtime API shape from `ms-types`: first
`system.activateApp(bundleId)` / `system.startApp(bundleId)`, then
`hid.openApp(appNameOrBundleId)` as fallback.

## Build And Tests

```powershell
npm run build
npm test
npm run test:virtual
npm run test:smoke
npm run test:smoke:runtime
```

The headless artifact is generated at `out/headless/phone-agent.js`.

`npm run test:virtual` uses committed synthetic phone screenshots and scene
replay fixtures. It does not connect to a real phone. To validate the same
screens with the real language and vision models, configure `AI_*` and
`VISION_*` environment variables, then run:

```powershell
npm run test:virtual:live
```

The smoke tests discover the local KuaiJS bridge, read status/screenshot/source,
and verify that the KuaiJS project runtime can execute a no-op script. HTTP
control authorization (`isAuth=false`) is diagnostic only.
