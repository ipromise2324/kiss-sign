# Perturbation recordings

`<name>.json` holds every request `pnpm perturb <name> --record <name>` sent to Alchemy and drpc, with each answer, for one test transaction of a shipped template: the unchanged run and each copy with one free field changed. `pnpm report` and `test/canaries/perturb.canary.ts` replay every `.json` file here; see [Perturbation tests](../README.md#perturbation-tests).
