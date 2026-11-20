# Working on WhatToWatch

Several agents often work on this project at the same time. Each works in its own git
worktree: T3 Code starts new conversations in one and runs `npm ci` there first.

## Your worktree

- Work and commit only in your own worktree. Leave the main checkout
  (`/Users/quirin/Projekte/what-to-watch`) and other agents' worktrees alone.
- Git-ignored local files are not copied into a worktree. For a release build, write a
  temporary `android/key.properties` whose `storeFile` is the absolute path of the main
  checkout's `android/upload-keystore.jks`, build, then delete it.

## Putting work on main

When the user wants the work on main:

1. `git fetch origin`, rebase onto `origin/main`, run the tests (`npx tsc --noEmit`, `npm test`).
2. `git push origin HEAD:main`.
3. Tell the other agents that are running that main moved and which files changed
   (Claude Code: `ListAgents`, then `SendMessage`). They rebase before they push.

## When the work is done

Once the work is on main and the user says they are done, delete your worktree and its
branch as the very last step (the conversation's folder goes away with it):

```sh
git status --short                                     # must be empty
git fetch origin
git merge-base --is-ancestor HEAD origin/main          # must succeed: everything is on main
cd /Users/quirin/Projekte/what-to-watch
git worktree remove <your worktree path>
git branch -D <your branch>
```

If either check fails, don't delete anything: tell the user what is not on main yet.
