import convoManager from '../../../src/agent/conversation.js';

const QUERY_TIMEOUT_MS = 45000;

// The swappable boundary between the Disclosure Loop and however messages
// actually move between agent processes. Today it's a thin wrapper over the
// stock ConversationManager; nothing above this class should touch
// convoManager directly, so the transport can be replaced later without
// touching the loop itself. See colab_agent/docs/08-phase-1-world-state-document.md §6.
export class TeammateChannel {
  constructor() {
    this._pending = new Map(); // partnerName -> { resolve, reject, timer }
  }

  // Called from ColabCoordinatorAgent.handleMessage. Returns true if the
  // message was consumed as the answer to an outstanding query.
  tryResolve(sender, message) {
    const pending = this._pending.get(sender);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pending.delete(sender);
    console.log(`[Disclosure Loop] <- ${sender}: ${message}`);
    pending.resolve(message);
    return true;
  }

  async askTeammate(name, question) {
    if (this._pending.has(name)) {
      throw new Error(`Already awaiting a reply from ${name}`);
    }
    console.log(`[Disclosure Loop] -> ${name}: ${question}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(name);
        console.warn(`[Disclosure Loop] no reply from ${name} within ${QUERY_TIMEOUT_MS}ms`);
        reject(new Error(`No reply from ${name} within ${QUERY_TIMEOUT_MS}ms`));
      }, QUERY_TIMEOUT_MS);
      this._pending.set(name, { resolve, reject, timer });

      if (convoManager.inConversation(name)) {
        convoManager.sendToBot(name, question);
      } else {
        convoManager.startConversation(name, question);
      }
    });
  }

  // The real !endConversation command handler only clears local state — it
  // never notifies the other side (src/agent/commands/actions.js:514-526).
  // The "other side" mechanism is that ConversationManager.sendToBot flags a
  // message end:true whenever its text contains the substring
  // "!endConversation", which the receiver's _handleFullInMessage acts on.
  // So closing a conversation cleanly on both ends requires both: sending a
  // message carrying that substring, and clearing local state ourselves. Order
  // matters — endConversation() sets ignore_until_start, and sendToBot drops
  // the message if that's already set, so the farewell must go out first.
  endConversation(name, farewellMessage) {
    if (!convoManager.inConversation(name)) return;
    convoManager.sendToBot(name, `${farewellMessage} !endConversation("${name}")`);
    convoManager.endConversation(name);
  }
}
