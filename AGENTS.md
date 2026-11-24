# Working on WhatToWatch

Several agents often work on this project at the same time. Each works in its own git
worktree: T3 Code starts new conversations in one and runs `npm ci` there first.

## Your worktree

- Work and commit only in your own worktree. Leave the main checkout
  (`/Users/quirin/Projekte/what-to-watch`) and other agents' worktrees alone.
- Git-ignored local files are not copied into a worktree. For a release build, write a
  temporary `android/key.properties` whose `storeFile` is the absolute path of the main
  checkout's `android/upload-keystore.jks`, build, then delete it. `npm run phone` does
  this by itself and installs your branch on the phone plugged in over USB.

## Putting work on main

main only takes pull requests. When the user wants the work on main:

1. `git fetch origin`, rebase onto `origin/main`, run the tests (`npx tsc --noEmit`, `npm test`).
2. `git push -u origin HEAD` and open a pull request. Fill in its template in plain words:
   the user reads it instead of the code. For anything visible, add a screenshot from
   the emulator.
3. Turn on auto-merge: `gh pr merge --auto --squash`. GitHub merges it once both checks
   pass: `check` (types and tests) and `sensitive`.
4. `sensitive` fails when the pull request touches what the user wants to see first:
   dependencies, permissions, version and signing, sign-in and key storage, the model's
   questions, the privacy policy, a web address the app has not used before, these rules
   and the CI (the list is in `.github/sensitive.sh`). Tell the user what changes there
   and why. They add the label `ok` when they agree; never add it yourself.
5. If `check` fails or the pull request has conflicts, fix it on your branch, rebase
   onto `origin/main` and push again with `git push --force-with-lease`.

Releases are the user's: don't push tags (README → Releases).

## When the work is done

Once your pull request is merged and the user says they are done, delete your worktree
and its branch as the very last step (the conversation's folder goes away with it):

```sh
git status --short                                     # must be empty
gh pr view --json state,headRefOid --jq '.state, .headRefOid'
                                                       # must print MERGED and `git rev-parse HEAD`
cd /Users/quirin/Projekte/what-to-watch
git worktree remove <your worktree path>
git branch -D <your branch>
```

If either check fails, don't delete anything: tell the user what is not on main yet.
