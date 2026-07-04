# PleiadeAI: OpenCode Skill System, Autonomy & Resilience Protocols

## 1. Multimodal Input Processing
PleiadeAI agents can "see" images via the backend's OpenAI-compatible proxy to `llama.cpp` (which must be running a VLM with the `--mmproj` projector flag).
- **Direct Input:** The user can drag and drop an image into the chat UI. The frontend converts this to a Base64 string and sends it as an `image_url` block in the user message array.
- **Tool-Acquired Input:** If an agent uses a skill (e.g., `take_screenshot` or `fetch_graph`), the skill runner can return a Base64 image payload to the EventBus. The JIT builder appends this image into the agent's context window, allowing the agent to analyze the generated visual without user intervention.

## 2. The Dynamic Skill Environment & Reliability Engine
Skills are modular TypeScript or Python scripts stored dynamically in MongoDB, mimicking an OpenCode engine.
*   **Sandbox Limitation:** All skills execute strictly inside the isolated bounds of the `pleiade_backend` Docker container. Skills *cannot* execute code directly on the host server's bare-metal OS. Any external interaction must occur via network APIs or standard external SSH loopbacks explicitly called out as verified arguments.
*   **Execution Isolation:** TypeScript runs via native child worker threads. Python executes via spawned isolated sub-processes handling data over clean `stdin`/`stdout` JSON streams.
*   **Skill Execution Boundaries:** Every sandbox execution is wrapped in a hard timeout counter (defaulting to 15 seconds). If a skill hangs or encounters an infinite loop, the backend forcefully kills the worker process or child thread via an internal watchdog timer.
*   **Skill Circuit Breaker:** If a dynamic skill throws uncaught exceptions or triggers process terminations three consecutive times, the system trips a circuit breaker for that skill, marking it as `disabled` in MongoDB and logging the event to Pino to prevent crashing the agent loop.

## 3. Remote Inference Failures & Upstream Resilience
When the remote `llama.cpp` inference engine throws network errors or encounters context window timeouts:
*   **Graceful Recovery:** The `LLAMAGateway` catches the request failure, retries twice with an exponential backoff strategy, and, if still unreachable, aborts execution gracefully.
*   **State Restitution:** Rather than crashing the current runtime sequence, the backend drops a structured exception payload into the event stream (`{"error": "Inference Engine Timeout"}`), allowing the active agent to attempt a correction path or explain the backend network interruption clearly to the frontend UI.

## 4. Multi-Agent Recursion Guard
When agents communicate with each other via the `ask_agent` tool or call out to a Developer Agent for new skills, a strict constraint is enforced:
*   **Hop Limit:** The system maintains an internal counter tracking cross-agent calls. If the depth exceeds a hard limit of **3 agent-to-agent hops**, the EventBus immediately breaks the circuit, drops execution, and returns a structural error to prevent runaway inference token exhaustion.
*   **UI Transparency:** The frontend treats these hops as full sub-chat panels. The user can watch Agent A explicitly framing questions to Agent B in real-time.

## 5. Autonomous Cron Scheduling & Conflict Architecture
Autonomous cron tasks are powered by **Agenda** pointing to MongoDB.
*   **Concurrency Lock:** If a cron job fires while a user is actively communicating with that exact same agent in the chat UI, the user chat takes absolute priority. The background cron task enters a queue and **must wait** until the active user session has naturally resolved and returned to an idle state.
*   **Dual Alert Pipeline:** When a headless background task completes and triggers an alert, the backend pushes it to two channels simultaneously:
    1.  A persistent `notifications` document is generated in MongoDB to await user review in the UI.
    2.  An immediate dispatch tool shoots the alert out to an external Telegram bot channel.
*   **Headless Observability:** Because headless tasks lack an active UI connection, all logical decisions, tool payloads, and generation completions are logged via Pino at the `info` and `debug` levels to ensure complete visibility into the cron loop.