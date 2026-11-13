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

   The script fast-forwards the main checkout at `~/.t3/projects/music`, rebuilds `dist/music-tv.apk` when `apps/tv` or the Cargo files changed since the last deploy (`--tv` rebuilds it anyway), and builds the commit as a release in `~/.local/share/music/releases/`. It does not restart anything. It stages the release, and `music-release.timer` puts it live once nothing has played on any device for 10 minutes, so a deploy never interrupts the music. Several merges in a row go live together. It refuses to run when the main checkout is off `main` or has uncommitted changes; report that to Josh instead of discarding the changes.

   Pass `--now` only when Josh asks for the change live right away, or for an urgent fix to something that is broken now. It restarts the server immediately, even mid-song.

8. Tell Josh the PR link, that it merged, and that it is staged: it goes live the next time nothing has played for 10 minutes (or now, with `--now`). The phone loads the new web app the next time the PWA opens. If the TV app was rebuilt, tell him the TV will show "Update ready" after the switch, and that he installs it from Settings → Install update. The TV never installs by itself.

   You can't see a TV change on the real TV until Josh installs it. Check TV changes before merging: render the screens to PNG files and look at the visuals in the visuals lab (both in README "TV app").

## If something fails

- If a check fails and you cannot fix it within the task, stop before merging and report the failure.
- If the deploy fails after the merge, `main` is ahead of the staged release. Do not revert the merge. Fix the problem in a new PR if it is in the code, and report it if it is not.
- If the TV build fails, the deploy stops before staging anything, and the next deploy rebuilds the TV app. Read the error, fix it, and run `./scripts/deploy-main.sh` again. Never report a deploy as staged unless the script printed `Staged <sha>.` (or `Live: <sha>.` with `--now`).
- If a release does not come up when it goes live, `scripts/activate-release.sh` goes back to the release before and logs it in `journalctl --user -u music-release.service`.
