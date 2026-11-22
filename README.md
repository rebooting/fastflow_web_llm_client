# Local Chat

A local browser chat interface for an OpenAI-compatible FastFlowLM server. Chat history, settings, and prompt presets are stored in SQLite on the machine running the app. The browser only contacts the app's relative `/api` routes; the app contacts FastFlowLM.

Use the star beside the model picker to favorite or unfavorite the selected model; favorites are remembered in this browser.

## Run with Docker Compose

Install Docker with Compose. Configure the upstream address for your environment, then from this directory run (replace this documentation-only IP and port):

```sh
FASTFLOWLM_BASE_URL=http://192.0.2.10:8000 docker compose up --build -d
```

Open <http://127.0.0.1:8080>. The named `chat-data` volume persists the SQLite database across container restarts and rebuilds. `docker compose down` stops the app without deleting that volume. `docker compose down -v` also permanently deletes its data.

The Compose default upstream is `http://fastflowlm:8000`: an example service name and container-side port on a shared Docker network. Override both to match your setup, for example:

```sh
FASTFLOWLM_BASE_URL=http://your-fastflowlm-service:9000 FRONTEND_PORT=8081 docker compose up --build -d
```

If FastFlowLM is another container, both services must join a shared Docker network. Set `FASTFLOWLM_BASE_URL` to its **Compose service name and its internal listening port**, for example `http://fastflowlm:8000`; the host-published port may be different. When integrating `chat-app` into an existing Compose file, copy the service definition, point `build` at this repository directory, and attach it to the same network as the FastFlowLM service. Use the actual upstream service name and container-side port in your deployment. The URL may include `/v1`; the app adds it when omitted.

The default bind address is loopback. To make the app reachable on your network, set `CHAT_BIND_ADDRESS` to the desktop’s LAN IP (for example `192.0.2.10`), or use `0.0.0.0` for all interfaces, and configure `FRONTEND_PORT`. The app has no login; anyone who can reach it can read and modify its chats and use the connected model. Restrict network access accordingly.

## Local development

Use Python 3.12 or newer and Node.js 22 or newer:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm ci
FASTFLOWLM_BASE_URL=http://192.0.2.10:8000 uvicorn app.main:app --host 127.0.0.1 --port 8080
```

Replace `192.0.2.10:8000` with your FastFlowLM host and listening port; use `127.0.0.1:8000` when it runs on the same host. In a second terminal run `npm run dev` and open the Vite URL. Vite proxies `/api` to `http://127.0.0.1:8080` by default; set `VITE_API_PROXY_TARGET` when the app server is elsewhere. The upstream URL is configured on the Python server, not in the browser. Without `FASTFLOWLM_BASE_URL`, the Python server defaults to `http://127.0.0.1:8000`. Set `CHAT_DATA_DIR` to change the database directory (default `./data`).

Run `npm run build` to type-check and build the UI into `dist/`; the Python server serves that directory when it exists. Run a single Uvicorn worker: generation cancellation is coordinated in the server process.
