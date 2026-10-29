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

Both `npm publish` and `npm stage publish` are allowed. The package requires 2FA
for interactive publishing and rejects bypass-2FA tokens.

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
   npm pack --dry-run
   ```

4. Commit, tag, and push with the durable Git identity:

   ```bash
   git commit -am "release: dsh-ego-webqa <version>"
   git tag -a "v<version>" -m "dsh-ego-webqa <version>"
   git push
   git push origin "v<version>"
   ```

The tag workflow verifies that the tag matches `package.json`, reruns all
checks, and publishes through npm OIDC with provenance.

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
