# Releasing

The npm package uses npm Trusted Publishing from GitHub Actions. No
`NPM_TOKEN`, npm automation token, or bypass-2FA token is stored in GitHub or
on a release workstation.

## Persistent authentication

GitHub source pushes use a repository-specific SSH key configured through
`core.sshCommand`. This keeps ordinary `git push` independent of a browser
session, a personal access token, or an interactive 2FA prompt.

The release workflow has:

- `permissions.id-token: write`;
- environment `npm`;
- no `NODE_AUTH_TOKEN`;
- `npm publish --access public --provenance`.

The npm Trusted Publisher entry is:

- package: `dsh-ego-webqa`;
- provider: GitHub Actions;
- owner: `ROY32172310`;
- repository: `dsh-ego-webqa`;
- workflow: `release.yml`;
- environment: `npm`.

`npm stage publish` is always allowed for Trusted Publishers created after
2026-09-03. Direct `npm publish` is a separate permission and must be enabled
explicitly in the Trusted Publisher configuration. The package requires 2FA for
interactive publishing and rejects bypass-2FA tokens.

If direct publishing is not enabled, npm can accept the release workflow while
placing the version in the Staged Packages area. A maintainer must then approve
it with 2FA. The release workflow now queries the public registry after upload
and fails unless the exact package version is visible, so staged-only mode can
no longer appear as a successful public release.

## Publish a version

1. Update the tested `ego-webqa` pin in `cordis.patch.yml` and README when the
   Python package changes.
2. Update the package version in `package.json` and refresh
   `package-lock.json` with `npm install --package-lock-only`.
3. Run the release checks:

   ```bash
   npm ci --legacy-peer-deps
   npm test
   npm run check
   node bin/dsh-ego-webqa.mjs --help
   npm pack --dry-run --json
   ```

   Run the real two-fixture MCP acceptance before tagging when the pinned QA
   release and a local Chromium are available:

   ```bash
   node bin/dsh-ego-webqa.mjs verify
   ```

4. Commit, tag, and push with the durable Git identity:

   ```bash
   git commit -am "release: dsh-ego-webqa <version>"
   git tag -a "v<version>" -m "dsh-ego-webqa <version>"
   git push
   git push origin "v<version>"
   ```

The tag workflow verifies that the tag matches `package.json`, reruns all
checks, publishes through npm OIDC with provenance, and verifies that the exact
version is visible in the public registry.

## Verify

```bash
npm view dsh-ego-webqa@<version> version dist.integrity --json
curl -fsS \
  "https://registry.npmjs.org/-/npm/v1/attestations/dsh-ego-webqa@<version>" |
  jq '{count:(.attestations | length),
       predicateTypes:([.attestations[].predicateType] | unique)}'
```

The attestation list must include both the npm publish attestation and SLSA
provenance. A successful publish must not create or require a repository
secret.

A transient 404 or stale `dist-tags.latest` immediately after the workflow ends
does not by itself prove staged-only publishing. Retry the public Registry
queries, inspect the version's timestamp and `_npmUser`, and check the
attestation endpoint before changing permissions or approving a staged package.

If the release job reports that the version is not publicly visible, do one of
the following:

1. Enable direct publishing for the existing Trusted Publisher and rerun the
   release workflow.
2. Review the pending version in npm's **Staged Packages** area and approve it
   with 2FA, then verify the registry and attestation again.

Until the version is public, the Pages market index continues to advertise the
current `dist-tags.latest` release rather than a version that users cannot
install. Redeploy the Pages workflow after approval so the index advances.
