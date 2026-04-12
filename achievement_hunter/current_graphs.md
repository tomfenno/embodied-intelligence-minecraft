_PTD not yet generated._

---

# SCSG — www
_Updated: 2026-04-12T14:10:00.677Z · r=1_

```mermaid
graph LR
    wooden_pickaxe["wooden_pickaxe ×1<br/>[tool]"]
    crafting_table["crafting_table ×1<br/>[workstation]"]
    stick["stick ×4<br/>[item]"]
    any_plank["any_plank ×12<br/>[item]"]
    any_log["any_log ×3<br/>[resource]"]
    any_log -->|"×3"| any_plank
    any_plank -->|"×4"| crafting_table
    any_plank -->|"×2"| stick
    any_plank -->|"×3"| wooden_pickaxe
    stick -->|"×2"| wooden_pickaxe
    crafting_table -->wooden_pickaxe
    style wooden_pickaxe fill:#4CAF50,color:#fff,stroke:#388E3C
```

---

# Candidates — www
_Updated: 2026-04-12T14:10:00.679Z · 1 source node(s)_

```mermaid
graph LR
    any_log["any_log ×3<br/>[resource]"]
```

---

<table width="100%"><tr>
<td width="50%" valign="top">

## Current Task
_Updated: 2026-04-12T14:10:13.912Z_

```json
{
  "target_item": "any_log",
  "qty": 3,
  "action_type": "collect",
  "parameters": {
    "source_block": "oak_log",
    "item_dependency": null,
    "tool": null
  }
}
```

</td>
<td width="50%" valign="top">

## Current Action _(attempt 4)_
_Updated: 2026-04-12T14:10:16.884Z_

```
!searchForBlock("oak_log", 128)
```

</td>
</tr></table>