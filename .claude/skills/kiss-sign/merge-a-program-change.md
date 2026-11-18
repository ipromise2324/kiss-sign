# Merge a program change

How to do [Merge a program change](SKILL.md#merge-a-program-change): the only pull requests you merge yourself.
The rules are in [The program gate](../../../docs/design/program-ownership.md#the-program-gate).

A program pull request changes no hand-written file under `templates/` or `registry/` and no file of the program gate; it may render an existing generated report again, but never add or delete one.
The signer does not read its code, so merge only after all of these, in order:

1. Push the branch and open the pull request to the signer's fork.
2. In the signer's clone with its checkout exactly `origin/main` (`git fetch origin`, then `git status` shows main up to date and nothing changed), run `pnpm program-gate origin/<branch>`.
   It runs main's gate on the branch: the typecheck, every canary of `docs/canaries.txt` and every other test.
   The branch must hold the current `origin/main`; merge it in first, never rebase.
   Require exit 0 and a last line that starts with `ELIGIBLE`; note the commit sha it names, the commit it judged.
   `NOT ELIGIBLE` names why.
   Exit 3 means the branch changes a template, the registry or a gate file, or drops a test with no verdict core change.
   When it also changes the verdict core, split it: the core change in a pull request of its own, the rest handed to the signer; otherwise hand that pull request to the signer.
   Exit 1 means a check failed, the clone is not exactly `origin/main`, the branch does not hold it or cannot be compared, or it changes the verdict core and drops a test, which you split into two pull requests: fix it.
   Exit 2 means a wrong argument.
3. Require the pull request's `program-gate` CI job to pass and its log to end with an `ELIGIBLE` line that names the same commit sha.
   The two lines differ in the branch name (CI judges `pull/head`), so compare the sha, never the whole line.
   The job also passes, with the notice "The signer merges this pull request", on a pull request that is the signer's to merge, so a green job alone is not enough.
4. Spawn a fresh subagent as the reviewer.
   Give it `git diff origin/main...<sha>`, pinned to that sha, `docs/design.md` and `docs/design/`, and the program-gate output, not your summary or your reasons.
   Ask whether the change weakens any check `verify` runs, lets any transaction reach `MATCH` that main would refuse, or edits a test so it stops catching something, and to answer `NO SECURITY REGRESSION` or name each regression it finds.
   Merge only when it answers `NO SECURITY REGRESSION`; otherwise fix what it names and start again at step 2.
5. Merge exactly the commit the gate and the reviewer judged, with a merge commit: `gh pr merge <number> --merge --match-head-commit <sha>`, with that sha.
   A push after that starts again at step 2.
   Never squash, rebase or force-push.
