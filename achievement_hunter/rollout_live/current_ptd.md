# PTD — Pick up a diamond from the ground\.

**LLM latency**
- **PTD generation:** 1m 15s

```mermaid
graph LR
    diamond["diamond ×1<br/>[resource]"]
    iron_pickaxe["iron_pickaxe ×1<br/>[tool]"]
    iron_ingot["iron_ingot ×3<br/>[item]"]
    raw_iron["raw_iron ×3<br/>[resource]"]
    furnace["furnace ×1<br/>[workstation]"]
    coal["coal ×1<br/>[resource]"]
    stone_pickaxe["stone_pickaxe ×1<br/>[tool]"]
    cobblestone["cobblestone ×11<br/>[resource]"]
    wooden_pickaxe["wooden_pickaxe ×1<br/>[tool]"]
    stick["stick ×8<br/>[item]"]
    crafting_table["crafting_table ×1<br/>[workstation]"]
    any_plank["any_plank ×12<br/>[item]"]
    any_log["any_log ×3<br/>[resource]"]
    iron_pickaxe -->diamond
    iron_ingot -->|"×3"| iron_pickaxe
    stick -->|"×2"| iron_pickaxe
    crafting_table -->iron_pickaxe
    raw_iron -->|"×3"| iron_ingot
    coal -->iron_ingot
    furnace -->iron_ingot
    stone_pickaxe -->raw_iron
    cobblestone -->|"×8"| furnace
    crafting_table -->furnace
    cobblestone -->|"×3"| stone_pickaxe
    stick -->|"×2"| stone_pickaxe
    crafting_table -->stone_pickaxe
    wooden_pickaxe -->cobblestone
    wooden_pickaxe -->coal
    any_plank -->|"×4"| stick
    any_plank -->|"×4"| crafting_table
    any_plank -->|"×3"| wooden_pickaxe
    stick -->|"×2"| wooden_pickaxe
    crafting_table -->wooden_pickaxe
    any_log -->|"×3"| any_plank
    style diamond fill:#4CAF50,color:#fff,stroke:#388E3C
```