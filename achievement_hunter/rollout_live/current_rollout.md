<table width="100%" style="table-layout: fixed; border-collapse: separate; border-spacing: 0;"><tr>
<td width="72%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

_PTD not yet generated._

</td>
<td width="2%"></td>
<td width="26%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

<div align="center" style="height: 100%; display: flex; flex-direction: column; justify-content: center;">
<div style="font-size: 0.85em; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; margin-bottom: 0.6em;">Elapsed</div>
<div style="font-size: 3.4em; font-weight: 800; line-height: 1; margin: 0 0 0.3em 0; white-space: nowrap;">25s</div>
<div style="font-size: 0.95em; font-weight: 600;">Running</div>
</div>

</td>
</tr></table>

---

<table width="100%" style="table-layout: fixed; border-collapse: separate; border-spacing: 0;"><tr>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

# SCSG — TEST
_r=0_

```mermaid
graph LR
    cooked_porkchop["cooked_porkchop ×1<br/>[item]"]
    porkchop["porkchop ×1<br/>[resource]"]
    furnace["furnace ×1<br/>[workstation]"]
    cobblestone["cobblestone ×8<br/>[resource]"]
    porkchop -->cooked_porkchop
    furnace -->cooked_porkchop
    cobblestone -->|"×8"| furnace
    style cooked_porkchop fill:#4CAF50,color:#fff,stroke:#388E3C
```

</td>
<td width="2%"></td>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

# Candidates — TEST
_2 source node\(s\)_

```mermaid
graph LR
    porkchop["porkchop ×1<br/>[resource]"]
    cobblestone["cobblestone ×8<br/>[resource]"]
```

</td>
</tr></table>

---

<table width="100%" style="table-layout: fixed; border-collapse: separate; border-spacing: 0;"><tr>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

**Current Task**

```json
{
  "target_item": "cobblestone",
  "qty": 8,
  "action_type": "collect",
  "parameters": {
    "source_block": "stone",
    "item_dependency": null,
    "tool": "wooden_pickaxe"
  }
}
```

</td>
<td width="2%"></td>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

**Current Action** _(attempt 1)_

```
!collectBlocks("stone", 8)
```

**Previous:**

- _(attempt 1)_ `!craftRecipe("wooden_pickaxe", 1)`
- _(attempt 1)_ `!craftRecipe("crafting_table", 1)`
- _(attempt 1)_ `!craftRecipe("stick", 1)`
- _(attempt 1)_ `!craftRecipe("spruce_planks", 3)`
- _(attempt 1)_ `!collectBlocks("spruce_log", 3)`

</td>
</tr></table>