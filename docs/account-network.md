# Account network

KithMoot has a device installation account-network choice, stored under
`kithmoot.account-network.v1`: `private-invitations` or `nostr`. This is product
policy, independent of MLS preview/development flags and account/sign-in method.

An existing saved choice wins. Without a saved choice the distribution uses
`VITE_ACCOUNT_NETWORK_DEFAULT`; unset/empty means `nostr`, preserving the ordinary
distribution. A private-invitations distribution sets
`VITE_ACCOUNT_NETWORK_DEFAULT=private-invitations`. An invalid distribution value
fails Vite configuration and app initialisation. Invalid or inaccessible saved
policy fails closed to private invitations. Removing the saved choice returns to
the distribution default. The choice is resolved synchronously before signer
restore and before auxiliary service construction.

Account network is available before sign-in, on the home/door account controls
and in profile privacy settings. Only its explicit Enable Nostr action enables
public account networking. A URL, restored signer or ordinary feature does not
change the choice. The UI explains what public relays can observe and which
services are paused. If saving a private choice fails, this tab stops public
services and holds privately; it reports the unsaved choice and offers a retry.
It does not claim that another tab or future launch has persisted that choice.

Private invitations retains signer/root-key custody, local account room and
pending bookmark journals, unopened encrypted invitation/project/contacts caches,
and private Link/Bothy/VMLS flows. It starts no ordinary account pools, Spry
kind-30078 sync, bookmarks/read-position publication, shared-project kind-1059
sync, public profiles/follows/NIP-05, Contacts/public box discovery or ordinary
room watchers. It does not ask the signer to encrypt/decrypt ordinary feature
caches merely to populate the paused UI. Explicit ordinary actions show the
required-mode disclosure. This policy does not change generic library transports,
MLS wire formats, private signer operations or storage withdrawal policy.

The gate is installed at app composition before public transport allocation,
including the public delegate of an ordinary room route. Selected private room
delegates remain available. Public transport writes use the existing guarded
socket carrier. Policy generations, current storage reads, old-service closure,
HTTP abort and callback guards prevent retained publishers, late signer results,
reconnects and old responses from resuming after a transition. Storage events are
wakeups; their payload is never trusted as current policy. Active ordinary rooms
and calls close on a private transition, preserving drafts and pending data.
Enabling Nostr creates fresh services and resumes pending account sync.

`app/src/account-network.test.ts` exercises the production `accountSyncServices`
composition with real account services and the real Nostr client over recording
in-process WebSockets. It covers cold private restore/reconnect without optional
signer requests, pending journal preservation/resumption, late signatures,
stalled socket writes, retained handles and callbacks, cross-tab lease races,
unsaved private holds, HTTP abort and a private room delegate. These checks are
local transport evidence, not live-stack or physical-device acceptance.
