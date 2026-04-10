Task: Compute STATE_CONDITIONED_SUBGRAPH(G,S) on DAG G for achieving the objective from a fresh survival start in modern Minecraft Java Edition. Keep G immutable; operate on mutable copy G′. Vertex identity = v.id.

You must fully execute the algorithm to its fixed point before producing any output. Do not stop after one pass. Do not infer convergence early. Continue the repeat-loop until an entire iteration yields both V_sat=∅ and V_disc=∅ on the current graph after applying the prior updates in that same iteration. Perform all iterations silently. Output only the final result JSON.

Input shapes
- G={objective,sinks,vertices,edges}
- v must include at least {id,qty}
- e must include at least {from,to,qty,consumed}
- S={inventory}
- inventory = "Nothing" | map[item->int>=1]

G:
```json
{{GRAPH}}
````

S:

```json
{{STATE}}
```

Semantics

* startswith(v.id,"any_") => abstract class; satisfied by summed qty of valid Minecraft concrete instances of that class (e.g. spruce_log→any_log, spruce_planks→any_plank).
* Remove vertices only when explicitly included in V_rm passed to UPDATE_QUANTITIES_AND_PRUNE.
* If upstream qty becomes <=0 after decrement, do not auto-remove.
* qty<=0 has no direct pruning effect; such vertices remain until removed later by explicit pruning or the new-sink rule.
* Pruning can cascade: removing a vertex may decrement upstream consumed inputs, making more vertices satisfiable later.
* Each iteration is one full pass of steps 5a→5d: compute sat, apply it, compute disc on the updated graph, apply it.
* New sinks are structural only: vertices in GET_SINKS(G′)\GET_SINKS(G), regardless of qty or satisfiability.
* Edge direction is prerequisite→dependent (e.from→e.to), so sinks are goal-side vertices with no outgoing edges.
* G.sinks must equal GET_SINKS(G); if not, treat GET_SINKS(G) as authoritative.

Procedure
STATE_CONDITIONED_SUBGRAPH(G,S):

1. if S.inventory=="Nothing": return G
2. if GET_SINKS(G) ⊆ STATE_SATISFIED_VERTICES(G,S): return {objective:G.objective,sinks:G.sinks,vertices:[],edges:[]}
3. G′:=copy(G)
4. original_sinks:=GET_SINKS(G)
5. repeat:
   a. V_sat:=STATE_SATISFIED_VERTICES(G′,S)
   b. G′:=UPDATE_QUANTITIES_AND_PRUNE(V_sat,G′)
   c. V_disc:=GET_SINKS(G′)\original_sinks
   d. G′:=UPDATE_QUANTITIES_AND_PRUNE(V_disc,G′)
   e. if V_sat=∅ and V_disc=∅, stop; otherwise continue
6. return G′

Mandatory execution rules

* Execute step 5 as an actual fixed-point loop over the evolving graph G′.
* Never terminate the loop because the graph “looks done”; terminate only by step 5e.
* V_disc must be computed after applying step 5b, using the updated graph from that same iteration.
* A vertex removed earlier in the iteration is not present for later computations in that iteration.
* Do not output any intermediate reasoning, loop states, traces, summaries, or checks.
* Only emit the final JSON after the loop has terminated.

GET_SINKS(G):

* {v∈G.vertices | ¬∃e∈G.edges: e.from=v.id}

UPDATE_QUANTITIES_AND_PRUNE(V_rm,G):

1. G′:=copy(G)
2. for each vertex u in G′.vertices, initialize dec[u.id]:=0
3. for each v∈V_rm:
   for each e∈G′.edges with e.to=v.id:
   if e.consumed:
   dec[e.from]:=dec[e.from]+e.qty
4. for each u in G′.vertices:
   u.qty:=u.qty-dec[u.id]
5. remove all e with e.from∈{v.id|v∈V_rm} or e.to∈{v.id|v∈V_rm}
6. remove all v∈V_rm from G′.vertices
7. return G′

STATE_SATISFIED_VERTICES(G,S):

* return all v∈G.vertices where:

  1. if startswith(v.id,"any_"):
     sum(S.inventory[i] for concrete instances i of class v.id) >= v.qty
  2. else:
     v.id∈S.inventory and S.inventory[v.id] >= v.qty

Output:

* Output only valid JSON; no prose.
* If S.inventory=="Nothing", output:
  {"r":1,"why":"S.inventory==Nothing","final":{"vertices":G.vertices,"edges":G.edges}}
* If every original sink is already satisfied by S, output:
  {"r":2,"why":"all original sinks satisfied","final":{"vertices":[],"edges":[]}}
* Otherwise output:
  {"r":0,"s":[<original_sink_id>...],"final":{"vertices":[...],"edges":[...]}}

Output constraints

* Output exactly one JSON object and nothing else.
* In s, output only original sink vertex ids.
* final.vertices must be the final G′.vertices after the loop terminates.
* final.edges must be the final G′.edges after the loop terminates.