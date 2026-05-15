import random
from pathlib import Path

# Minecraft Java Edition numeric seed range:
MIN_SEED = -(2**63)
MAX_SEED = 2**63 - 1

NUM_SEEDS = 50

# Fixed meta-seed so this script is reproducible.
# Change this number if you want a different random seed list.
RNG_SEED = 42

def main():
    rng = random.Random(RNG_SEED)

    seeds = [rng.randint(MIN_SEED, MAX_SEED) for _ in range(NUM_SEEDS)]

    output_path = Path(__file__).parent / "candidate_seeds.txt"

    with output_path.open("w", encoding="utf-8") as f:
        for seed in seeds:
            f.write(f"{seed}\n")

    print(f"Wrote {NUM_SEEDS} seeds to {output_path}")

if __name__ == "__main__":
    main()