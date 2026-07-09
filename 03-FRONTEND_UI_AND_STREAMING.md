# PleiadesAI: Frontend Command Center & WebSockets

## 1. Developer Interface Design
The frontend uses Next.js or Vite with Tailwind CSS and `shadcn/ui`, built into an optimized production Nginx container. It utilizes a high-density, wide-layout dark mode designed for clear data parsing.

**Required Views:**
1.  **Authentication Guard:** Secure lock screen validating JWT tokens.
2.  **Agent Workspace (Chat & Debugger):** Features a standard chat panel alongside an expandable split-pane. This drawer acts as a live debugger, showing exact tool calls, sandbox timeouts, cross-agent hop traces, and internal reasoning (`<think>`) blocks in real-time.
3.  **Skill & Agent Matrix:** CRUD panel for MongoDB configurations. Features an integrated Monaco Editor for script coding, and an **editable Key-Value grid** displaying the agent's current local parameters.
4.  **Memory Vault:** Fully segregated inspector layout. Allows selecting an agent, inspecting their isolated Qdrant vector block, and explicitly deleting corrupted memories.
5.  **Autonomy & Inbox Monitor:** A control board listing upcoming Agenda tasks alongside the unread `notifications` inbox. Includes a global execution kill switch.

## 2. WebSocket Protocol Schema
Streams pass through a real-time WebSocket connection. The frontend relies entirely on this schema for real-time dual-state visualization (switching between text streams and dynamic loading indicators).

```json
// Token streaming (Standard text or internal reasoning blocks)
{ "type": "stream_chunk", "agent": "devops_agent", "content": "Analyzing logs...", "is_reasoning": false }

// Sub-Agent invocation trace (Shows the user the background cross-agent loop)
{ "type": "agent_hop", "from": "devops_agent", "to": "home_coordinator", "depth": 1, "query": "Get room temperature" }

// Tool/Skill execution start state
{ "type": "tool_start", "agent": "devops_agent", "tool": "run_python_script" }

// Execution conclusion
{ "type": "tool_end", "agent": "devops_agent", "status": "success", "result": "0 errors found" }

// Sandbox / Inference Recovery Event Notification
{ "type": "system_alert", "level": "error", "message": "Circuit breaker tripped for skill: run_python_script" }