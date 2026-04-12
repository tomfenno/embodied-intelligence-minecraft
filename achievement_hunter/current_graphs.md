# PTD — Smelt an iron ingot.
_Updated: 2026-04-12T01:29:37.053Z_

```mermaid
graph LR
    iron_ingot["iron_ingot ×1<br/>[item]"]
    raw_iron["raw_iron ×1<br/>[resource]"]
    furnace["furnace ×1<br/>[workstation]"]
    stone_pickaxe["stone_pickaxe ×1<br/>[tool]"]
    cobblestone["cobblestone ×11<br/>[resource]"]
    wooden_pickaxe["wooden_pickaxe ×1<br/>[tool]"]
    stick["stick ×4<br/>[item]"]
    crafting_table["crafting_table ×1<br/>[workstation]"]
    any_plank["any_plank ×12<br/>[item]"]
    any_log["any_log ×3<br/>[resource]"]
    raw_iron -->iron_ingot
    any_plank -->iron_ingot
    furnace -->iron_ingot
    stone_pickaxe -->raw_iron
    cobblestone -->|"×8"| furnace
    crafting_table -->furnace
    cobblestone -->|"×3"| stone_pickaxe
    stick -->|"×2"| stone_pickaxe
    crafting_table -->stone_pickaxe
    wooden_pickaxe -->cobblestone
    any_plank -->|"×2"| stick
    any_plank -->|"×3"| wooden_pickaxe
    stick -->|"×2"| wooden_pickaxe
    crafting_table -->wooden_pickaxe
    any_plank -->|"×4"| crafting_table
    any_log -->|"×3"| any_plank
    style iron_ingot fill:#4CAF50,color:#fff,stroke:#388E3C
```

---

# SCSG
_Updated: 2026-04-12T01:29:37.055Z_

**All sinks satisfied (r=2) — task complete.**


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