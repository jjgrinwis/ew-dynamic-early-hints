---
name: deploy
description: Version bump and deploy EdgeWorker to staging or production
---

# Deploy EdgeWorker

Guides through version bumping and deployment of hints-reader or hints-updater EdgeWorker.

## Steps

1. **Ask which EdgeWorker to deploy**:
   - hints-reader
   - hints-updater

2. **Ask for version bump type** (follow semantic versioning):
   - patch (x.x.1) - Bug fixes, small changes
   - minor (x.1.0) - New features, improvements  
   - major (1.0.0) - Breaking changes

3. **Ask for target environment**:
   - staging
   - production

4. **Execute deployment**:
   ```bash
   cd <hints-reader|hints-updater>
   npm version <patch|minor|major>
   npm run deploy:<staging|production>
   ```

5. **Report results**:
   - Show new version number
   - Confirm deployment target
   - Remind: "You cannot re-activate an already-active version"

## Notes

- Always bump version first (npm version) before deploying
- Deployment runs: build → package → upload → activate
- If static hints changed, remind to run `/reset-hints` after deployment
