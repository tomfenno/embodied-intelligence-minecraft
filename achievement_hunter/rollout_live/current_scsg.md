# SCSG — test take 2
_r=0_

```mermaid
graph LR
    cake["cake ×1<br/>[item]"]
    milk_bucket["milk_bucket ×3<br/>[item]"]
    sugar["sugar ×2<br/>[item]"]
    sugar_cane["sugar_cane ×2<br/>[resource]"]
    milk_bucket -->|"×3"| cake
    sugar -->|"×2"| cake
    sugar_cane -->|"×2"| sugar
    style cake fill:#4CAF50,color:#fff,stroke:#388E3C
```