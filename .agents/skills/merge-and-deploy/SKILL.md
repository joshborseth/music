---
name: merge-and-deploy
description: Open a PR, merge it to main, and deploy the music app. Use as the last step of every task that changes files in this repo, and whenever asked to merge, ship, or deploy.
---

# Merge and deploy

Run this as the last step of every task that changed files in this repo. Do not wait to be asked.

Skip it when the task changed nothing. If Josh asked for no push, no PR, no merge, no deploy, or a draft, stop before the step he ruled out and tell him where you stopped.

The repo has no CI and no branch protection, so the checks in step 3 are the only gate before `main`.

## Steps

1. Commit the work on the task branch. Never commit to `main`.
2. Bring the branch up to date. Resolve any conflicts so that both sides' work survives.

   ```bash
   git fetch origin main
   git rebase origin/main
   ```

3. Run every check. Fix each failure and rerun. Never merge with a failing check. Give each command a 10-minute timeout, because builds and type checks can wait in the machine's memory queue.

   ```bash
   bun install --frozen-lockfile
   bun run typecheck
   bun run test
   bun run lint
   bun run build
   ```

   If the change touches `apps/tv`, also run `cargo test -p music-tv`.

4. Push the branch.

   ```bash
   git push --force-with-lease -u origin HEAD
   ```

5. Open the PR, or reuse the one already open for this branch. Write the title in the imperative. In the body, say what changed, why, and how you checked it.

   ```bash
   gh pr create --base main --title "<title>" --body "<body>"
   ```

6. Squash-merge the PR. Do not pass `--delete-branch`: it fails in a worktree, because `main` is checked out elsewhere. If the merge reports a conflict, go back to step 2.

   ```bash
   gh pr merge <number> --squash
   ```

7. Deploy. Give the command a 10-minute timeout, or 45 minutes when the TV app changed, because the APK build is slow.

   ```bash
   ./scripts/deploy-main.sh
   ```

   The script fast-forwards the main checkout at `~/.t3/projects/music` (the service runs from there), builds the web app, and restarts `music.service`. It rebuilds `dist/music-tv.apk` when `apps/tv` or the Cargo files changed since the last deploy. Pass `--tv` to rebuild it anyway. It refuses to run when the main checkout is off `main` or has uncommitted changes; report that to Josh instead of discarding the changes.

8. Tell Josh the PR link, that it merged, and that the deploy finished. The script exits nonzero if the live site does not match the build. If the TV app was rebuilt, tell him to install it on the TV from `http://192.168.1.67:4310/tv.apk`. The phone picks up the new web app the next time the PWA opens.

## If something fails

- If a check fails and you cannot fix it within the task, stop before merging and report the failure.
- If the deploy fails after the merge, `main` is ahead of the live site. Do not revert the merge. Fix the problem in a new PR if it is in the code, and report it if it is not.
- Restarting the service drops whatever is playing for a moment. That is expected.
