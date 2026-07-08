# NIMCheck

NIMCheck is a static status dashboard for NVIDIA NIM free endpoints. A scheduled GitHub Actions job probes the configured models, writes `public/status.json`, and the website renders that recent snapshot.

The public site does not need an always-on backend, and the NVIDIA API key stays in GitHub Secrets.

## Local Preview

```bash
npm start
```

Open `http://localhost:3000`.

To generate `public/status.json` locally:

```bash
cp .env.example .env
# edit .env and set NVIDIA_API_KEY
npm run check
```

## Deployment

1. Push this repository to GitHub.
2. Add a repository secret named `NVIDIA_API_KEY`.
3. Enable GitHub Pages and set the source to GitHub Actions.
4. The workflow in `.github/workflows/check-endpoints.yml` runs every 10 minutes, generates `public/status.json`, and deploys the `public` directory.

## Models

Scheduled checks use `config/models.json`.

The website also has a model input. Models added there are saved in the browser's local storage as a personal watchlist. To make a model part of the shared scheduled status page, add it to `config/models.json` and commit the change.

## Settings

The scheduled checker reads these environment variables:

| Name | Default |
| --- | --- |
| `NVIDIA_API_KEY` | required for live checks |
| `NVIDIA_ENDPOINT` | `https://integrate.api.nvidia.com/v1/chat/completions` |
| `CHECK_INTERVAL_MS` | `600000` |
| `REQUEST_TIMEOUT_MS` | `20000` |
| `SLOW_THRESHOLD_MS` | `8000` |
| `MODEL_CONCURRENCY` | `3` |
| `PROBE_MAX_TOKENS` | `32` |
| `HISTORY_LIMIT` | `48` |

NVIDIA documents the chat endpoint as OpenAI-compatible at `https://integrate.api.nvidia.com/v1/chat/completions`.
