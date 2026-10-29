# dsh-ego-webqa

DSH bundle for [ego-webqa](https://github.com/ROY32172310/qa). It exposes the
existing deterministic web-delivery audit as a native DSH MCP tool without
duplicating any browser checks in TypeScript.

After installation, the model sees:

```text
mcp__ego_webqa__audit_web_page
```

The tool checks a page across the mobile matrix, returns the existing
`agent_summary.json` contract, and retains screenshots plus `report.json` as
evidence.

## Why a bundle instead of another tool implementation

DSH already ships `@deepseek-ai/dsh-mcp-client`. This package contributes one
declarative Cordis patch row that starts:

```text
uvx ego-webqa@0.5.0 mcp
```

DSH supervises that process, discovers `audit_web_page`, applies normal tool
approval and cancellation, and reconnects it if the process exits. The Python
package remains the single source of truth for detectors, thresholds, report
schemas, and release compatibility.

## Requirements

- DSH `>=0.1.5-rc.1 <0.3.0`
- `uv` / `uvx` available on `PATH`
- A Playwright Chromium browser available to the `uvx` environment

Install Chromium once for the pinned ego-webqa version:

```bash
uvx --from ego-webqa@0.5.0 playwright install chromium
```

On Linux CI hosts without a desktop browser, use:

```bash
uvx --from ego-webqa@0.5.0 playwright install --with-deps chromium
```

## Install

```bash
dsh plugin --profile web add dsh-ego-webqa
```

DSH 0.2.1+ can also discover it from the published format-1 market index:

```text
https://roy32172310.github.io/dsh-ego-webqa/index.json
```

The index is validated with `@deepseek-ai/dsh-plugin-market-index` in CI.
The deployed index resolves the newest publicly visible release from the npm
registry. A staged-only package version is not advertised until it is approved.

Inspect the resulting layer without starting DSH:

```bash
dsh --profile web --dump-config
```

Start DSH normally or explicitly select the profile:

```bash
dsh --profile web
```

For another installed profile, replace `web` with that profile's name.

The first MCP launch may take longer while `uvx` creates its isolated Python
environment. Later launches reuse that cache.

## Use

Ask DSH to audit the deployed URL before delivery, for example:

```text
Audit https://preview.example before you call the page complete.
```

The MCP tool accepts the URL and the existing bounded audit options, including
`browser_engine` with `chromium`, `firefox`, or `webkit`. Chromium remains the
default; install the selected Playwright engine separately. Playwright WebKit is
not a real-device Safari run. Its structured result includes:

- delivery status (`pass`, `warn`, or `fail`);
- aggregated blocking and warning findings;
- suggested fixes and reproduction commands;
- paths to `agent_summary.json`, `report.json`, and screenshots.

A blocking page defect is a successful tool execution with a `fail` report.
An execution error means the browser, CLI, or MCP process could not complete,
and must not be presented as a page-quality failure.

## Operational boundaries

- One tool call represents one bounded audit invocation.
- The MCP server exposes one tool. There is no second set of DSH-only checks.
- `safe` smoke mode remains the default in ego-webqa; side effects require the
  existing explicit live-mode configuration in the Python tool.
- The MCP client scrubs credential-shaped environment variables before starting
  the child process.
- This bundle does not install Python, `uvx`, or Chromium implicitly. Missing
  prerequisites fail visibly instead of silently disabling QA.

## Versioning

The bundle pins the tested ego-webqa version in `cordis.patch.yml`. A DSH
adapter release is required only when its compatibility window or MCP launch
contract changes, not for every detector release in the Python package.

To use a locally installed CLI instead of `uvx`, override the generated row in
the profile's `cordis.patch.yml`:

```yaml
- id: ego-webqa
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: ego_webqa
    transport: stdio
    command: ego-webqa
    args: [mcp]
    cwd: !!js process.cwd()
    toolCallTimeoutMs: 90000
    failOnStartupError: true
    reconnect:
      enabled: true
      initialDelayMs: 500
      maxDelayMs: 30000
      maxAttempts: 10
```

## Troubleshooting

If the tool is absent, inspect the DSH log for the `ego-webqa` MCP row. Common
causes are:

- `uvx` is not on the DSH process `PATH`;
- the pinned ego-webqa package version cannot be downloaded;
- Chromium was installed for a different `uv` cache or user account;
- the configured DSH version is outside `engines.dsh`.

Run the underlying server directly to isolate DSH from the Python package:

```bash
uvx ego-webqa@0.5.0 mcp
```

For a normal CLI audit and complete evidence, run:

```bash
uvx ego-webqa@0.5.0 https://preview.example --out .qa/dsh
```

## License

MIT
