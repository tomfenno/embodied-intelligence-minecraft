Repair a candidate answer for a graph-pruning task.

Inputs:
1. ORIGINAL TASK PROMPT
2. PREVIOUS CANDIDATE ANSWER
3. AUDIT REPORT

Goal:
- Produce the corrected answer.
- Output valid JSON only.
- Preserve all correct parts.
- Make the minimal changes needed for full compliance.
- No prose, no markdown.

Rules

1. Follow the ORIGINAL TASK PROMPT exactly.

2. Mode
- If S.inventory=="Nothing": output r:1 only.
- Else if all original sinks are satisfied: output r:2 only.
- Else: output r:0 with s, it, final.

3. r:0 structure
- s = original sink ids.
- Each iteration must contain sat, g1, disc, g2.
- Include terminating iteration sat=[] and disc=[].
- final must equal the last graph state after termination.

4. Graph updates
- UPDATE_QUANTITIES_AND_PRUNE is simultaneous:
  a. accumulate decrements from consumed incoming edges to V_rm
  b. apply decrements
  c. remove incident edges of V_rm
  d. remove vertices in V_rm
- Remove only V_rm.
- qty<=0 does not auto-prune.
- disc = GET_SINKS(current_graph)\original_sinks.

5. "same"
- Use "same" only if unchanged from the immediately previous graph state.
- If changed, replace "same" with the full corrected graph snapshot.

6. Dependency propagation
- If an earlier iteration changes, recompute all affected later iterations and final.
- Keep the existing output mode if correct; change it only if wrong.
- Do not rewrite correct parts unnecessarily.
- Do not add fields.
- Do not reorder arrays unless needed for correctness.

Output only the corrected JSON answer.

ORIGINAL TASK PROMPT:
{{FULL TASK PROMPT WITH CONCRETE G AND S}}

PREVIOUS CANDIDATE ANSWER:
```json
{{PREVIOUS CANDIDATE JSON}}
```

AUDIT REPORT:
```json
{{AUDIT REPORT JSON}}
```