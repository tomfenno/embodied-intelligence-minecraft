# SCSG — test
_r=0_

```mermaid
graph LR
    iron_block["iron_block ×4<br/>[item]"]
    carved_pumpkin["carved_pumpkin ×1<br/>[item]"]
    iron_ingot["iron_ingot ×38<br/>[item]"]
    raw_iron["raw_iron ×20<br/>[resource]"]
    coal["coal ×5<br/>[resource]"]
    furnace["furnace ×1<br/>[workstation]"]
    crafting_table["crafting_table ×1<br/>[workstation]"]
    any_plank["any_plank ×9<br/>[item]"]
    any_log["any_log ×3<br/>[resource]"]
    stick["stick ×4<br/>[item]"]
    wooden_pickaxe["wooden_pickaxe ×1<br/>[tool]"]
    cobblestone["cobblestone ×11<br/>[resource]"]
    stone_pickaxe["stone_pickaxe ×1<br/>[tool]"]
    shears["shears ×1<br/>[tool]"]
    pumpkin["pumpkin ×1<br/>[resource]"]
    iron_ingot -->|"×36"| iron_block
    crafting_table -->iron_block
    raw_iron -->|"×38"| iron_ingot
    coal -->|"×5"| iron_ingot
    furnace -->iron_ingot
    stone_pickaxe -->raw_iron
    wooden_pickaxe -->coal
    any_log -->|"×3"| any_plank
    any_plank -->|"×4"| crafting_table
    any_plank -->|"×3"| wooden_pickaxe
    stick -->|"×2"| wooden_pickaxe
    crafting_table -->wooden_pickaxe
    any_plank -->|"×2"| stick
    cobblestone -->|"×3"| stone_pickaxe
    stick -->|"×2"| stone_pickaxe
    crafting_table -->stone_pickaxe
    cobblestone -->|"×8"| furnace
    crafting_table -->furnace
    wooden_pickaxe -->cobblestone
    iron_ingot -->|"×2"| shears
    pumpkin -->carved_pumpkin
    shears -->carved_pumpkin
    style iron_block fill:#4CAF50,color:#fff,stroke:#388E3C
    style carved_pumpkin fill:#4CAF50,color:#fff,stroke:#388E3C
```