# PTD — Craft one type of every tool
_Updated: 2026-04-11T03:35:46.396Z_

```mermaid
graph LR
    any_log["any_log ×5<br/>[resource]"]
    any_plank["any_plank ×20<br/>[item]"]
    stick["stick ×8<br/>[item]"]
    crafting_table["crafting_table ×1<br/>[workstation]"]
    wooden_pickaxe["wooden_pickaxe ×1<br/>[tool]"]
    wooden_axe["wooden_axe ×1<br/>[tool]"]
    wooden_shovel["wooden_shovel ×1<br/>[tool]"]
    wooden_hoe["wooden_hoe ×1<br/>[tool]"]
    any_log -->|"×5"| any_plank
    any_plank -->|"×4"| crafting_table
    any_plank -->|"×4"| stick
    any_plank -->|"×3"| wooden_pickaxe
    stick -->|"×2"| wooden_pickaxe
    crafting_table -->wooden_pickaxe
    any_plank -->|"×3"| wooden_axe
    stick -->|"×2"| wooden_axe
    crafting_table -->wooden_axe
    any_plank -->wooden_shovel
    stick -->|"×2"| wooden_shovel
    crafting_table -->wooden_shovel
    any_plank -->|"×2"| wooden_hoe
    stick -->|"×2"| wooden_hoe
    crafting_table -->wooden_hoe
    style wooden_pickaxe fill:#4CAF50,color:#fff,stroke:#388E3C
    style wooden_axe fill:#4CAF50,color:#fff,stroke:#388E3C
    style wooden_shovel fill:#4CAF50,color:#fff,stroke:#388E3C
    style wooden_hoe fill:#4CAF50,color:#fff,stroke:#388E3C
```

---

_SCSG not yet generated._

---

<table width="100%"><tr>
<td width="50%" valign="top">

## Current Task
_NTS not yet run._

</td>
<td width="50%" valign="top">

## Current Action
_AM not yet run._

</td>
</tr></table>