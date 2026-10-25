# Designated admin devices: local browser qualification

25 October 2026. This candidate implements the selected designated group admin
policy in an explicit development preview. It has not been deployed or published.
The production engine pin and production MLS gate remain unchanged. The retained
Invitation1 preview keeps its own strict 16-key reader, domains and snapshot 4
opener; it is a separate experimental compatibility path.

## Exact local input

The new loader uses only `app/public/vmls-wasm-admin-invitation/`, an ignored local
qualification input. It requires source commit
`5b3eb5fe28255b5c0cc09d959a3010a3d48f9562`, target web, qualificationOnly and
experimental flags, snapshot version 5, profile `Vennel/invitation-admins/2`,
policy `designated-leaf-admins/1`, and the pinned SHA-256 of both JS and WASM.
The preparation script additionally verifies the generated TypeScript declaration.
Missing, changed, legacy and unknown inputs refuse with no fallback.

From the browser worktree, prepare the reviewed local bundle before typechecking:

```sh
node scripts/prepare-admin-invitation-preview.mjs /Users/darren/WebstormProjects/vennel/release/admin-policy-20261025/artifacts/5b3eb5fe28255b5c0cc09d959a3010a3d48f9562/web
npm ci --no-audit --no-fund
npm run typecheck
```

Use only the explicit Admin2 flag alongside the outer development MLS flag:

```sh
VITE_BROWSER_MLS_PREVIEW=true VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW=true npm run demo
```

Do not enable `VITE_BROWSER_MLS_INVITATION_PREVIEW` at the same time. Select the
**Designated admin devices** option when creating a room. Exchange invitation,
response and package registration bytes only in the intended authenticated private
conversation. The expected inviter remains a separately selected trust pin.

## Authority and protected state

An admin role belongs to one current authenticated MLS device leaf. A person's
other or replacement devices do not inherit it. Storage keeper permission is
independent. Native applied roles, read using `getCurrentAdminRolesV1`, supply the
role view. Pending joins expose no applied role view. The room's protected record
explicitly says `InvitationAdmins2`, retains the policy commitment and chooses
`openAdminInvitationSession`; snapshot 5 cannot be opened through a legacy path.
Trusted restart still requires the actual surviving local installation marker.

The independent browser reader requires the exact canonical 17-key version-2
context. The enclosing signing body stays version 1. The typed vault purpose
`signAdminInvitationV2/1` recomputes the new authorization digest, verifies the
original signed leaf/person credential, checks the protected room and complete
admin commitment, journals before consent and rechecks after consent. Native
preparation and completion enforce actual current admin authority.

Ordinary members can send messages and perform their identity-preserving Update.
Current admin devices can invite, remove and change roles. Role controls target
one exact current leaf and carry the policy commitment reviewed in the last native
role view; `setAdminRolesV1` checks it atomically. The last admin cannot be removed
or demoted. Applied commits update the protected commitment. A changed policy
conservatively stales older invitations. Node package registration and private
routes confer no MLS admin authority.

## Validation and boundaries

The targeted offline browser journey uses the real protected store, coordinator,
typed vault, custody and exact WASM. Synthetic software identities, root provision
replies and authenticated node/witness transport remain test fixtures. It covers
ordinary-member restrictions and Update/message use, exact-leaf promotion,
demotion, stale intent, last-admin refusal, snapshot-5 restart, subsequent admission
by the promoted admin, separate keeper registration and removal of the demoted
creator. The actual panel checks per-device wording and reviewed-policy controls.

```sh
npx vitest run src/vmls/admin-invitation.test.ts src/vmls/invitation.test.ts app/src/mls-admin-roles.test.ts app/src/mls-coordinated-vault.test.ts app/src/mls-invitation-continuity.test.ts --maxWorkers=1
npx playwright test -c playwright.admin-invitation.config.ts
```

Independent vectors are copied unchanged from the native branch's public Python
reference. Their dummy unsigned credentials are not identity/admission evidence.
The reader's signed-leaf tests use the existing valid browser binding fixture.
No mixed-client, physical-device, production, hostile transport or independent
security acceptance is claimed by these checks.

## Disposable mixed-client controller readiness

The lab bridge chooses exactly one development profile from the outer MLS flag
and one invitation flag. `create` selects only that engine; `profile()` reports
`InvitationAdmins2` or the separate `Invitation1` lab. `snapshot` retains the native
profile and applied `adminRoles`, hashes message bodies and wipes those returned
bodies. `roles` provides the same applied view without message history. Pending
reads expose no applied roles and clear the last review. `role` requires one exact
64-hex device leaf, a boolean role and `expectedCommitment` equal to the last
reviewed native role view for that session. The review is consumed by the action;
the protected operation still checks current authority and commitment atomically.

Run `test/mixed-invitation-controller.mjs` only after fresh fixture endpoints and
the built Bark input have been coordinated. Admin2 requires these explicit inputs:

```sh
MIXED_INVITATION_LAB_PROFILE=InvitationAdmins2
MIXED_INVITATION_BROWSER_PROFILE=/absolute/path/to/fresh/private/browser-profile
MIXED_INVITATION_BARK_PATH=/absolute/path/to/reviewed/built-bark
MIXED_INVITATION_APP_URL=http://localhost:28445/j/
MIXED_INVITATION_CONTROL_URL=http://127.0.0.1:28440
```

The app server additionally needs `VITE_MIXED_INVITATION_LAB=true` and the two
Admin2 preview flags shown above. `lab-profile` verifies the actual page against
the controller selection before invitation operations. The legacy controller
selection remains `Invitation1`, with its own legacy flag and browser profile.
No profile or missing-asset fallback is available.

Arm observations before each ceremony through the private loopback controller.
`observe-start` accepts existing `needles` plus an optional `adminRoles` applied
view, adding the policy commitment and exact own/admin leaves as prospective
needles. `admin-policy` and `admin-refusal` are additional named windows. Receipts
expose counts and digests only. A later, previously unknown commitment requires a
new prospective window; it cannot be audited retrospectively. Browser readiness
checks do not establish a Bark/Link/Bothy mixed journey or physical acceptance.
