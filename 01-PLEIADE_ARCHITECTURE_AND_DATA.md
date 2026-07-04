# PleiadeAI: System Architecture, Data Models & Governance

## 1. Project Overview
PleiadeAI is an optimized, multi-agent AI orchestration platform designed as a developer-level command center. The system utilizes a stateless Node.js/TypeScript backend, an in-process EventBus for high-speed routing, and a remote `llama.cpp` instance for inference. All data states are fully transparent and exposed directly to the frontend chat UI.

**Core Technology Stack:**
- **Backend:** Node.js, TypeScript, native `EventEmitter`.
- **Observability:** `pino` for high-performance, structured JSON logging.
- **Database (State & Config):** MongoDB (with `migrate-mongo` for schema evolutions).
- **Database (Vector Memory):** Qdrant.
- **Inference Server:** Remote `llama.cpp` (OpenAI-compatible `/v1/chat/completions` endpoint, running with `--mmproj` for multimodal support).
- **Deployment:** Fully self-contained Docker Compose configuration.

## 2. Security, Authentication & Authorization
As a command center capable of sandboxed code execution, securing access is critical.
*   **API Security:** All HTTP REST endpoints are guarded by JSON Web Token (JWT) authentication passed via standard `Authorization: Bearer <token>` headers.
*   **WebSocket Security:** The real-time connection requires token verification during the connection upgrade handshake (`socket.io` authentication middleware). Expired tokens immediately drop the socket channel.
*   **Role Isolation:** Initial scope implements a single admin access pattern, which can expand via the database role arrays.

## 3. Data Schema & Migration Governance
To avoid deployment drift as agent configurations alter, all MongoDB models are strictly controlled via `migrate-mongo`. Data migrations are written as programmatic scripts tracking changes sequentially inside the `/migrations` repository directory.

**MongoDB `agents` Schema:**
- `_id`: ObjectId
- `name`: String (e.g., `devops_agent`)
- `system_prompt`: String
- `tools_allowed`: String[] (Static tools or dynamic skills)
- `qdrant_namespace`: String (Strictly isolated vector namespace)

**MongoDB `notifications` Schema:**
- `_id`: ObjectId
- `agent_id`: ObjectId
- `title`: String
- `content`: String
- `status`: Enum('unread', 'read')
- `created_at`: Date

## 4. Core EventBus Routing & Observability
An internal `EventEmitter` manages message flows. While the UI consumes live WebSocket streams, the backend utilizes Pino to generate persistent, structured logs for every system hop, tool invocation, and error, ensuring post-mortem debuggability for headless processes.

**Event Types:**
- `chat:user_message`: Primary user payload.
- `agent:stream_chunk`: Yielded iteratively as the LLM streams tokens (including reasoning blocks).
- `agent:tool_invoke`: Fires when an agent requests a tool or skill. Pauses text stream.
- `tool:execution_complete`: Resumes inference with structured execution payload.
- `agent:ask_agent`: Cross-agent invocation. Bridges two separate agent execution blocks.