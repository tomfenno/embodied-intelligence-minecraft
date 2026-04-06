Validate a candidate answer for a graph-pruning task.

Inputs:
1. ORIGINAL TASK PROMPT
2. CANDIDATE ANSWER JSON

Goal:
- Check exact compliance with the task spec.
- Be strict about algorithm semantics, output schema, and iteration correctness.
- Report only spec errors, not style.
- Output JSON only.

Checks

1. JSON/mode
- Answer must be valid JSON only.
- Allowed forms:
  - {"r":1,"why":"S.inventory==Nothing","final":{"vertices":[...],"edges":[...]}}
  - {"r":2,"why":"all original sinks satisfied","final":{"vertices":[],"edges":[]}}
  - {"r":0,"s":[...],"it":[...],"final":{"vertices":[...],"edges":[...]}}

2. Early return
- If S.inventory=="Nothing": must be r:1, no iterations.
- Else if all original sinks are satisfied: must be r:2, no iterations.
- Else: must be r:0.

3. Original sinks
- original_sinks = GET_SINKS(G).
- If G.sinks differs, GET_SINKS(G) is authoritative.
- In r:0, s must equal original_sinks.

4. sat
- sat must equal STATE_SATISFIED_VERTICES(current_graph,S).
- Satisfaction depends only on S.inventory.
- any_* uses summed valid concrete instances.
- Graph qty/reachability do not imply satisfaction.

5. prune
- UPDATE_QUANTITIES_AND_PRUNE is simultaneous:
  a. accumulate decrements from consumed incoming edges to V_rm
  b. apply decrements
  c. remove incident edges of V_rm
  d. remove vertices in V_rm
- Remove only V_rm.
- qty<=0 does not auto-prune.
- Non-consumed incoming edges do not decrement.

6. Iterations
- In r:0, each iteration is:
  - sat
  - g1 = prune(sat)
  - disc = GET_SINKS(g1)\original_sinks
  - g2 = prune(disc) from g1
- disc is structural only.
- "same" is valid only if unchanged from the immediately previous graph state.
- Terminating iteration sat=[] and disc=[] is required.

7. final
- final must equal the last graph state after the terminating iteration.
- If last g2=="same", final must equal the prior graph state.

8. Consistency
- Removed vertices/edges must not reappear unless an earlier state was wrong.
- If an earlier iteration is wrong, note downstream states as affected.

Return JSON only:

If correct:
{"ok":true,"errors":[],"summary":"Candidate exactly matches the task specification."}

If not:
{
  "ok":false,
  "errors":[
    {"path":"<json path>","problem":"<what is wrong>","expected":"<what should be true>"}
  ],
  "summary":"<brief assessment>"
}

ORIGINAL TASK PROMPT:
<PASTE FULL TASK PROMPT WITH CONCRETE G AND S>

CANDIDATE ANSWER JSON:
```json
<PASTE CANDIDATE JSON>
```