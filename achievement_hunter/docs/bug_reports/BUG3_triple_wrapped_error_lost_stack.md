# Doesn't matter
# BUG 3 — Triple-Wrapped Error / Lost Stack Trace

**Severity:** Low (developer experience)
**Status:** Confirmed from logs
**Branch:** hard-code-nts-am

---

## Symptom

```
[SPL] Command result: Action output:
!!Code threw exception!!
Error: Error: Error: Event updateSlot:0 did not fire within timeout of 20000ms
Stack trace:
undefined
```

Two problems:
1. `Error: Error: Error:` — the message is wrapped at least twice
2. `Stack trace: undefined` — stack is lost, making debugging harder

---

## Root Cause

The error originates in mineflayer's `craft.js:32`:

```javascript
} catch (err) {
    throw new Error(err)   // ← wraps err.message into a new Error
}
```

`new Error(err)` where `err` is already an Error object coerces it to string
(`err.toString()` = `"Error: <message>"`), producing `"Error: Error: <message>"`.
The resulting Error object is created without being thrown at construction time, so
V8 never populates its `.stack` property — stack is `undefined`.

Each re-wrap in the call chain (skills.js catch, actions.js catch, wherever the
result is serialized) adds another layer.

---

## Proposed Fix

### In mineflayer/craft.js (patch)

```diff
-      throw new Error(err)
+      throw err instanceof Error ? err : new Error(String(err))
```

### In any catch handler that re-wraps

Prefer re-throwing the original:

```javascript
// Instead of:
throw new Error(e.message ?? e)

// Use:
throw e
```

### In the result serializer (wherever "Stack trace: undefined" is printed)

```javascript
// Instead of:
`Stack trace:\n${e.stack}`

// Use:
`Stack trace:\n${e?.stack ?? e?.message ?? String(e)}`
```

---

## Impact

Without this fix, when BUG 2 (or any craft error) occurs, the stack trace is
`undefined`. Fixing this makes future debugging significantly faster by preserving
the original throw location.
