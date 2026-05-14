import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {
    buildRefs,
    MASTER_PATH,
    ROLE_OUTPUTS,
} from '../../../scripts/build_action_refs.mjs';

function format(arr) {
    return JSON.stringify(arr, null, 2) + '\n';
}

describe('actions_reference sync', () => {
    const masterText = readFileSync(MASTER_PATH, 'utf8');
    const generated = buildRefs(masterText);

    for (const [role, outPath] of Object.entries(ROLE_OUTPUTS)) {
        it(`${role}/actions_reference.json is up to date with the master`, () => {
            const current = readFileSync(outPath, 'utf8');
            const expected = format(generated[role]);
            expect(
                current,
                `${outPath} is stale. Run: node achievement_hunter/scripts/build_action_refs.mjs`,
            ).toBe(expected);
        });
    }
});
