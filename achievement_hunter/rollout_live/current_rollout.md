<table width="100%" style="table-layout: fixed; border-collapse: separate; border-spacing: 0;"><tr>
<td width="72%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

_PTD not yet generated._

</td>
<td width="2%"></td>
<td width="26%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

<div align="center" style="height: 100%; display: flex; flex-direction: column; justify-content: center;">
<div style="font-size: 0.85em; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; margin-bottom: 0.6em;">Elapsed</div>
<div style="font-size: 3.4em; font-weight: 800; line-height: 1; margin: 0 0 0.3em 0; white-space: nowrap;">10s</div>
<div style="font-size: 0.95em; font-weight: 600;">Running</div>
</div>

</td>
</tr></table>

---

<table width="100%" style="table-layout: fixed; border-collapse: separate; border-spacing: 0;"><tr>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

# SCSG — tset
_r=0_

```mermaid
graph LR
    cake["cake ×1<br/>[item]"]
    milk_bucket["milk_bucket ×3<br/>[item]"]
    sugar["sugar ×2<br/>[item]"]
    wheat["wheat ×3<br/>[resource]"]
    egg["egg ×1<br/>[resource]"]
    sugar_cane["sugar_cane ×2<br/>[resource]"]
    milk_bucket -->|"×3"| cake
    sugar -->|"×2"| cake
    wheat -->|"×3"| cake
    egg -->cake
    sugar_cane -->|"×2"| sugar
    style cake fill:#4CAF50,color:#fff,stroke:#388E3C
```

</td>
<td width="2%"></td>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

# Candidates — tset
_4 source node\(s\)_

```mermaid
graph LR
    milk_bucket["milk_bucket ×3<br/>[item]"]
    wheat["wheat ×3<br/>[resource]"]
    egg["egg ×1<br/>[resource]"]
    sugar_cane["sugar_cane ×2<br/>[resource]"]
```

</td>
</tr></table>

---

<table width="100%" style="table-layout: fixed; border-collapse: separate; border-spacing: 0;"><tr>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

**Current Task**

```json
{
  "target_item": "wheat",
  "qty": 3,
  "action_type": "collect",
  "parameters": {
    "source_block": "wheat",
    "item_dependency": null,
    "tool": "stone_hoe"
  }
}
```

</td>
<td width="2%"></td>
<td width="50%" valign="top" style="border: 1px solid #d0d7de; border-radius: 14px; padding: 18px 16px; box-sizing: border-box;">

**Current Action** _(attempt 6 · search)_

```
!searchForBlock("wheat", 511)
```

**Previous:**

- _(attempt 5 · search)_ `!searchForBlock("wheat", 256)`
- _(attempt 4 · search)_ `!searchForBlock("wheat", 128)`
- _(attempt 3 · search)_ `!searchForBlock("wheat", 64)`
- _(attempt 2 · search)_ `!searchForBlock("wheat", 32)`
- _(attempt 1)_ `!search("wheat")`

</td>
</tr></table>