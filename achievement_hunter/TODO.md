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


Here is a clearer version of that TODO:

#### SCSG Feedback and Refine Prompts

* These prompts currently include the entire original `SCSG prompt` as input. In contrast, the `PTD self-refine prompts` use a condensed version of the original prompt and take only the `objective` as input. We may be able to improve the `SCSG` prompts by following a similar design:

  * move a condensed version of the original `SCSG prompt` into the prompt itself
  * replace the full `SCSG prompt` input with the `PTD graph` as the main input

Here is a clearer version of that TODO:

#### Next Task Selector (NTS)

* The current `NTS` prompt only covers the basic functionality we want. We may want to expand its capabilities in the following ways:

1. Allow the `NTS` to prune the `SCSG` as it proceeds. This would let us reuse a single `SCSG` across multiple time steps, which could reduce the need to wait for a newly generated `SCSG`.

2. If we allow the `NTS` to prune the `SCSG`, we should also provide it with a history of environment `actions` as input.

3. Experiment with having the `NTS` output multiple `tasks`, either:

   * in no particular order, or
   * in a prioritized sequence

Here is a clearer version of that TODO:

#### Action Mediator (AM)

* The `AM` prompt may need to be expanded to accept a `memory` input, similar to the one used by `Andy`.

* We may also want to experiment with adding a dedicated `coding` prompt, similar to the setup used by `Andy`.

