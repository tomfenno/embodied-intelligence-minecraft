# 03 — Bot-to-Bot Communication

This answers: **do agents talk only via in-game chat? what other channels exist? where is it implemented? what protocol? how is routing decided?**

---

## 1. The headline: communication is out-of-band, not Minecraft chat

Each agent runs in a **separate OS process**. They coordinate over a dedicated **socket.io relay** routed through a central **MindServer** process. In-game Minecraft chat (`bot.chat`) is at most a cosmetic echo and is **explicitly ignored** as an inter-agent channel.

```
Agent A process ──('chat-message')──▶ MindServer ──('chat-message')──▶ Agent B process
  conversation.js   mindserver_proxy.js   mindserver.js   mindserver_proxy.js   conversation.js
```

Evidence that in-game chat is *not* the inter-agent channel:
- Open chat is dropped whenever other agents exist — `src/agent/agent.js:189-193`:
  ```js
  this.bot.on('chat', (username, message) => {
      if (serverProxy.getNumOtherAgents() > 0) return;   // ignore open chat in multi-agent
      respondFunc(username, message);
  });
  ```
- A whisper *from another bot* is treated as anomalous — `agent.js:173-175`: `if (convoManager.isOtherAgent(username)) console.warn('received whisper from other bot??')`.
- The in-game echo is optional/gated — `src/agent/conversation.js:150-151`: `if (settings.chat_bot_messages && open_chat) agent.openChat(...)`, whereas the socket send (`sendBotChatToServer`, `conversation.js:165`) is unconditional.

---

## 2. The three socket channels (`src/mindcraft/mindserver.js`)

The MindServer maps `agentName → socket` in `agent_connections` (`mindserver.js:17`), populated at `connect-agent-process`/`login-agent` (`mindserver.js:110,117`). Relevant events:

| Event | Purpose | Routing |
|---|---|---|
| `chat-message` | **bot-to-bot conversation** | **directed** to the named target agent |
| `send-message` | external/API message to an agent | directed; delivered to `agent.respondFunc(from, message)` |
| `bot-output` | display/telemetry to the web UI | broadcast (`io.emit`) |
| `agents-status` | presence list (who's in game) | broadcast |

The directed relay for conversation — `mindserver.js:141-148`:
```js
socket.on('chat-message', (agentName, json) => {
    if (!agent_connections[agentName]) { console.warn(`Agent ${agentName} ... not logged in`); return; }
    console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
    agent_connections[agentName].socket.emit('chat-message', curAgentName, json);  // forward, tag sender
});
```
`curAgentName` (the sender) is captured at the sender's login (`mindserver.js:121`) and re-attached when forwarding.

### Agent side (`src/agent/mindserver_proxy.js`)
- **Send** — `mindserver_proxy.js:129-131`:
  ```js
  export function sendBotChatToServer(agentName, json) {
      serverProxy.getSocket().emit('chat-message', agentName, json);
  }
  ```
- **Receive** — `mindserver_proxy.js:46-48`:
  ```js
  this.socket.on('chat-message', (agentName, json) => {
      convoManager.receiveFromBot(agentName, json);
  });
  ```
- Presence — `agents-status` handler (`mindserver_proxy.js:50-57`) → `convoManager.updateAgents(...)`, which feeds `isOtherAgent` / `otherAgentInGame`.

---

## 3. Message protocol

The bot-to-bot payload is a small JSON object built in `ConversationManager.sendToBot` (`conversation.js:158-162`):
```js
const end = message.includes('!endConversation');
const json = { message, start, end };   // start/end are conversation lifecycle flags
```
- `message` — the text (may contain commands like `!givePlayer(...)`).
- `start` — `true` on the opening message of a conversation.
- `end` — `true` when the message contains `!endConversation`.
- **Sender identity is NOT in the body** — it travels as the separate socket argument (`curAgentName`/`agentName`).

On receipt, text is prefixed for the LLM — `conversation.js:344-346`: `function _tagMessage(message) { return "(FROM OTHER BOT)" + message; }`.

The separate `send-message` (API) payload is `{ from, message }` (`mindserver_proxy.js:64-70`).

---

## 4. Conversation lifecycle & turn-taking — `src/agent/conversation.js`

State lives in `ConversationManager` (`conversation.js:45`) with a per-partner `Conversation` (`conversation.js:9`) tracking `.active`, `.ignore_until_start`, and a message `.in_queue`.

### Start
`!startConversation("<bot>", "<msg>")` command (`src/agent/commands/actions.js:497-513`) → `convoManager.startConversation(name, message)` (`conversation.js:121-134`): **pauses the self-prompter**, marks active, starts a monitor, and `sendToBot(..., start=true)`. The receiver enters via `receiveFromBot` → `startConversationFromOtherBot`.

### Turn-taking heuristic — `_scheduleProcessInMessage` (`conversation.js:273-307`)
Whether/when to reply depends on whether each side is busy:
```
both busy        → reply only if my current action is "talk-over-able", else stay silent
other busy/I free → schedule reply after a long delay
I busy/other free → ask the LLM (promptShouldRespondToBot) whether to reply
neither busy     → reply after a short delay
```
Messages arriving during the delay are **queued and coalesced** (`queue()` `conversation.js:39`; `_compileInMessages` `conversation.js:314-323`) into one bulk message before the agent responds.

### Monitor — `_startMonitor` (`conversation.js:64-107`)
Runs every 1s: if awaiting a response past `wait_time_limit` (starts 30s, doubles each timeout), nudges via `agent.handleMessage('system', "<partner> hasn't responded ...")`. If the partner left the game, a 10s timeout ends the conversation.

### End
`!endConversation` (`actions.js:515-525`) and the `end` flag. On an inbound `end=true`, the final message is re-routed to `'system'` so the bot processes the closure instead of replying (`conversation.js:332-336`). Ending resumes the self-prompter (`_resumeSelfPrompter`, `conversation.js:348-353`).

### The send/route fork — `routeResponse` (`agent.js:393-411`)
When the agent emits a reply, `routeResponse` decides the channel: if an **active conversation** exists with the target bot → `convoManager.sendToBot` (socket relay); otherwise → `openChat` (in-game/UI display). So directed bot-to-bot replies go over the socket; ambient narration goes to chat/UI.

---

## 5. How the system decides which bot gets which message

- **Directed by name.** Every `chat-message` carries an explicit target `agentName`; the MindServer forwards only to that agent's socket (`mindserver.js:141-148`). There is no conversational broadcast.
- The seed conversation targets the *first other available agent*: `available_agents.filter(n => n !== this.name)[0]` (`tasks.js:270`). For >2 agents, the task **goal text** instructs the agent to cycle partners using `startConversation`/`endConversation` (`tasks.js:100-116`) — there is no automatic group broadcast; the agent manages pairwise conversations sequentially.
- **Presence** is broadcast (`agents-status`) so every agent knows who is in-game (`isOtherAgent`, `otherAgentInGame`) for routing/teardown decisions.

---

## 6. Key files

| File | Role |
|---|---|
| `src/agent/conversation.js` | `ConversationManager` / `Conversation`: lifecycle, turn-taking, queueing, monitor, `(FROM OTHER BOT)` tagging |
| `src/agent/mindserver_proxy.js` | Per-agent socket.io client: `sendBotChatToServer`, `chat-message`/`send-message`/`agents-status` handlers |
| `src/mindcraft/mindserver.js` | Central relay hub: `agent_connections` map, directed `chat-message` forwarding |
| `src/agent/commands/actions.js:497-526` | `!startConversation` / `!endConversation` command defs |
| `src/agent/agent.js` | `respondFunc` (162-187), `handleMessage` (259-391), `routeResponse` (393-411), `openChat` (413-438) |

> **Implication for a new collaborative agent:** to participate in coordination you do **not** need to parse Minecraft chat. You hook the same socket relay — either by reusing `ConversationManager`/`mindserver_proxy` directly (receive via `convoManager.receiveFromBot` → `agent.handleMessage`, send via `routeResponse`/`sendToBot`), or by emitting/listening to the `chat-message` socket event yourself. See [doc 05](./05-interface-points-for-new-agent.md).
