<table width="100%" style="table-layout: fixed; border-collapse: separate; border-spacing: 0;"><tr>
<td width="72%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

_PTD not yet generated._

</td>
<td width="2%"></td>
<td width="26%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

<div align="center" style="height: 100%; display: flex; flex-direction: column; justify-content: center;">
<div style="font-size: 0.85em; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; margin-bottom: 0.6em;">Elapsed</div>
<div style="font-size: 3.4em; font-weight: 800; line-height: 1; margin: 0 0 0.3em 0; white-space: nowrap;">4m 51s</div>
<div style="font-size: 0.95em; font-weight: 600;">Running</div>
</div>

</td>
</tr></table>

---

<table width="100%" style="table-layout: fixed; border-collapse: separate; border-spacing: 0;"><tr>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

# SCSG — test
_r=0_

```mermaid
graph LR
    lava_bucket["lava_bucket ×1<br/>[item]"]
    bucket["bucket ×1<br/>[item]"]
    iron_ingot["iron_ingot ×3<br/>[item]"]
    bucket -->lava_bucket
    iron_ingot -->|"×3"| bucket
    style lava_bucket fill:#4CAF50,color:#fff,stroke:#388E3C
```

</td>
<td width="2%"></td>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

# Candidates — test
_1 source node\(s\)_

```mermaid
graph LR
    iron_ingot["iron_ingot ×3<br/>[item]"]
```

</td>
</tr></table>

---

<table width="100%" style="table-layout: fixed; border-collapse: separate; border-spacing: 0;"><tr>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

**Current Task**

```json
{
  "target_item": "iron_ingot",
  "qty": 3,
  "action_type": "smelt",
  "parameters": {
    "smelting_inputs": [
      {
        "item": "raw_iron",
        "qty": 3
      }
    ],
    "fuel_inputs": [
      {
        "item": "any_plank",
        "qty": 3
      }
    ],
    "workstation": "furnace"
  }
}
```

</td>
<td width="2%"></td>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

**Current Action** _(attempt 1)_

```
!smelt_item("raw_iron", 3, "oak_planks")
```

**Previous:**

- _(attempt 1)_ `!craftRecipe("oak_planks", 1)`
- _(attempt 2)_ `!collectBlocks("oak_log", 2)`
- _(attempt 20 · search)_ `!searchForBlock("oak_log", 128)`
- _(attempt 19 · search)_ `!searchForBlock("pale_oak_log", 64)`
- _(attempt 18 · search)_ `!searchForBlock("cherry_log", 64)`
- _(attempt 17 · search)_ `!searchForBlock("mangrove_log", 64)`
- _(attempt 16 · search)_ `!searchForBlock("dark_oak_log", 64)`
- _(attempt 15 · search)_ `!searchForBlock("acacia_log", 64)`
- _(attempt 14 · search)_ `!searchForBlock("jungle_log", 64)`
- _(attempt 13 · search)_ `!searchForBlock("birch_log", 64)`
- _(attempt 12 · search)_ `!searchForBlock("spruce_log", 64)`
- _(attempt 11 · search)_ `!searchForBlock("oak_log", 64)`
- _(attempt 10 · search)_ `!searchForBlock("pale_oak_log", 32)`
- _(attempt 9 · search)_ `!searchForBlock("cherry_log", 32)`
- _(attempt 8 · search)_ `!searchForBlock("mangrove_log", 32)`
- _(attempt 7 · search)_ `!searchForBlock("dark_oak_log", 32)`
- _(attempt 6 · search)_ `!searchForBlock("acacia_log", 32)`
- _(attempt 5 · search)_ `!searchForBlock("jungle_log", 32)`
- _(attempt 4 · search)_ `!searchForBlock("birch_log", 32)`
- _(attempt 3 · search)_ `!searchForBlock("spruce_log", 32)`
- _(attempt 2 · search)_ `!searchForBlock("oak_log", 32)`
- _(attempt 1)_ `!search("any_log")`
- _(attempt 2)_ `!collectBlocks("oak_log", 3)`
- _(attempt 2 · search)_ `!searchForBlock("oak_log", 32)`
- _(attempt 1)_ `!search("any_log")`
- _(attempt 1)_ `!craftRecipe("furnace", 1)`
- _(attempt 5)_ `!smelt_item("raw_iron", 3, "oak_planks")`
- _(attempt 4)_ `!smelt_item("raw_iron", 3, "oak_planks")`
- _(attempt 3)_ `!smelt_item("raw_iron", 3, "oak_planks")`
- _(attempt 2)_ `!smelt_item("raw_iron", 3, "oak_planks")`
- _(attempt 1)_ `!smelt_item("raw_iron", 3, "oak_planks")`
- _(attempt 1)_ `!smelt_item("raw_iron", 3, "oak_planks")`
- _(attempt 2)_ `!collectBlocks("iron_ore", 3)`
- _(attempt 2 · search)_ `!searchForBlock("iron_ore", 32)`
- _(attempt 1)_ `!search("iron_ore")`
- _(attempt 1)_ `!craftRecipe("stone_pickaxe", 1)`
- _(attempt 1)_ `!craftRecipe("furnace", 1)`
- _(attempt 1)_ `!collectBlocks("stone", 11)`
- _(attempt 1)_ `!craftRecipe("wooden_pickaxe", 1)`
- _(attempt 1)_ `!craftRecipe("crafting_table", 1)`
- _(attempt 1)_ `!craftRecipe("stick", 1)`
- _(attempt 1)_ `!craftRecipe("oak_planks", 3)`
- _(attempt 2)_ `!collectBlocks("oak_log", 3)`
- _(attempt 11 · search)_ `!searchForBlock("oak_log", 64)`
- _(attempt 10 · search)_ `!searchForBlock("pale_oak_log", 32)`
- _(attempt 9 · search)_ `!searchForBlock("cherry_log", 32)`
- _(attempt 8 · search)_ `!searchForBlock("mangrove_log", 32)`
- _(attempt 7 · search)_ `!searchForBlock("dark_oak_log", 32)`
- _(attempt 6 · search)_ `!searchForBlock("acacia_log", 32)`
- _(attempt 5 · search)_ `!searchForBlock("jungle_log", 32)`
- _(attempt 4 · search)_ `!searchForBlock("birch_log", 32)`
- _(attempt 3 · search)_ `!searchForBlock("spruce_log", 32)`
- _(attempt 2 · search)_ `!searchForBlock("oak_log", 32)`
- _(attempt 1)_ `!search("any_log")`

</td>
</tr></table>