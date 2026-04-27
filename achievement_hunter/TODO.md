##TODO

### Prompts

#### Self-Refine Prompts

* None of the four self-refine prompts have been tested thoroughly. We should improve them through iterative testing and refinement. One possible process is:

1. Create a `ChatGPT`-based `critic agent` by prompting it with the relevant background on self-refinement and the goals of our project.

2. Have the `critic` generate a test case for the `feedback` prompt. Each test case should include:

   * a `candidate graph`
   * an `objective`

3. Build a method that takes a `candidate graph` and an `objective`, then runs the full refinement loop until either:

   * the `candidate graph` is accepted by the `feedback` prompt, or
   * the maximum number of `iterations` is reached

   This method should log every response in a structured, machine-parseable file.

4. Pass the log file to the `critic` for evaluation.

5. If the `critic` identifies errors or weaknesses, update the prompts.

6. Repeat from step 2.

> **Note:** If a recurring but hard-to-diagnose bug appears, run step 3 in the web browser so the self-refine LLMs can be probed more directly.

#### Bug fixes
1. SGSG, need to condition on nearby blocks and account for pruning buckets.