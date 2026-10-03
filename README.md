# ghostcli-omp

GhostCLI provider extension for [omp](https://github.com/can1357/oh-my-pi).
Registers `ghostcli` as a first-class provider backed by the GhostCLI router
(`https://ghostcli.dev/v1`, OpenAI-compatible wire).

- **`/login ghostcli`** — paste an API key (`gcli_…`); it is validated with a
  minimal chat completion and stored in omp's auth store. Run it once per key:
  every stored credential participates in omp's multi-account
  selection/rotation, so usage-limit hits rotate to a sibling key
  automatically.
- **No `GHOSTCLI_API_KEY` env fallback** — see [Auth notes](#auth-notes).
- **Static + live models** — ships the known Claude/GLM catalog so
  `omp models ghostcli` works offline; a successful `GET /v1/models` fetch
  replaces/augments it (24 h model cache; `omp models refresh` forces a
  re-fetch). Verified context windows: Claude models **256k**, GLM 5.3 **1M**.

## Install

```sh
omp plugin install github:algochad/ghostcli-omp
```

Then authenticate (repeat once per key for multi-key rotation):

```sh
/login ghostcli
```

Verify:

```sh
omp models ghostcli
```

## Models

| Model | Context | Notes |
|-------|---------|-------|
| `claude-opus-5-5` | 256k | Strongest reasoning, `pro` plan |
| `claude-sonnet-5` | 256k | Balanced daily driver, `pro` plan |
| `claude-fable-5.1` | 256k | Fast/cheap, `max` plan |
| `z-ai/glm-5.3` | 1M | Long-context work, `pro` plan |

The router also lists a `z-ai/glm-5.3[1m]` display variant; it shares the
`z-ai/glm-5.3` request string, so the plugin dedupes it to one entry.

## Auth notes

`GHOSTCLI_API_KEY` used to be a tempting fallback, but it is not supported.

`apiKey` in `pi.registerProvider()` is registered as a **config override**,
which sits above stored credentials in omp's auth cascade:

```
runtime --api-key  >  config override  >  OAuth  >  /login key  >  env var  >  stored key
```

So `apiKey: "GHOSTCLI_API_KEY"` meant every request was pinned to that one env
key — multi-key rotation never engaged — and with the variable unset the
literal string `GHOSTCLI_API_KEY` was sent as the bearer, producing
`401 Invalid or revoked API key`.

`ProviderConfig` has no `envKeys` field, so an extension-registered provider
cannot register a genuine env fallback; the cascade's env step only covers
built-in catalog providers. An empty value is not a way out either: it fails
with `No API key found` rather than falling through to the store.

Leaving `apiKey` unset lets the cascade reach the credentials from
`/login ghostcli`, which is what enables:

- session stickiness (a session is pinned to one key),
- round-robin across sessions,
- automatic rotation to a sibling key on usage-limit hits.

If you need a non-interactive key, use `/login ghostcli` once, or pass
`omp --api-key gcli_…` for a single run.

One GhostCLI quirk: `GET /v1/models` is public (200 even with a bad key), so
it cannot validate a key. `/login ghostcli` instead probes
`POST /v1/chat/completions` with `max_tokens: 1` — a bad key gets a real
`401 Invalid or revoked API key`.

Update later with `omp plugin upgrade ghostcli-omp`. Manual alternatives
(extensions directory copy, `extensions:` in `config.yml`, `-e` flag for one
shot) still work but are not needed.

## Model roles (nexum + ghostcli combined)

After installing, point your roles at both providers, e.g.:

```yaml
# ~/.omp/agent/config.yml
modelRoles:
  default: nexum/meta-muse-spark-1.3
  smol: ghostcli/claude-fable-5.1:low
  slow: ghostcli/claude-opus-5-5:high
  vision: nexum/qwen-3.8-max
  plan: ghostcli/claude-opus-5-5:xhigh
  task: nexum/meta-muse-spark-1.3
  commit: ghostcli/claude-fable-5.1:low
  advisor: ghostcli/claude-opus-5-5:xhigh
```

Why this split: nexum's Spark 1.3 keeps the 1M-context default; GhostCLI's
Claude models (256k context) take the reasoning-heavy roles (slow/plan/
advisor) and the cheap Fable 5.1 takes smol/commit. For long-context plans,
swap `plan:` to `ghostcli/z-ai/glm-5.3:xhigh` (1M context).

## Development

```sh
npm install
npm run typecheck
npm run test:load -- ghostcli
```

## License

MIT
