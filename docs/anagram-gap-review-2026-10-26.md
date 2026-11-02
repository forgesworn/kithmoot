# Gaps identified in the Anagram comparison

26 October 2026. Source review with selected lessons now accepted into the
[product goals](product-goals.md), [client roadmap](client-roadmap.md) and
[execution plan](pwa-execution-plan.md). The table retains the review's suggested
priorities; the accepted goals and phased plan govern delivery. This is not a
runtime comparison or release claim. The [Anagram/Iroh assessment](research/anagram-iroh-20261026.md)
records the owner's direction to improve our existing stack without adopting
Iroh; it remains technical reference material, with no integration planned.

Accepted scope: strengthen G1–G3 with custody, recovery and bounded history;
G7/G10/G12 with audio continuity, lifecycle and efficient group media; G9 with
typed agent interactions; add G18 for ordinary Nostr interoperability. Message
pins/forwarding remain demand-led proposals. A recovery-master key schedule,
forward-secrecy changes and public-community discovery are not accepted by
this update. All added work and its named acceptance gates remain open.

Reviewed KithMoot `28786a0c42568b46f842e1dee249e57132ec2f86` and Anagram
`a4db9c697d77e3f8e15ca985af5e68677bc61a7d`. Native Android observations concern
its separate source and documentation; they do not establish release parity.

## Recommended order

| Priority | Gap and existing foundation | Useful Anagram evidence | Work to close it | Completion evidence |
| --- | --- | --- | --- | --- |
| 1 | History that remains useful beyond the active tab. KithMoot has an encrypted room archive and a separate imported-history index, but normal conversation search covers loaded messages. Archive reads open a whole conversation before applying the requested page limit. | Bounded local/remote pages, per-relay cursors, completed reads and committed ingestion before cursor advancement; crowded timestamp handling. | Finish G3 using paged encrypted storage and explicit coverage. Keep ordinary conversation history, imported account history and durable remote archives distinct. Preserve access checks and local encryption. | Recover/search a conversation older than 90 days with over 10,000 messages; test missing keys, unavailable replicas, restart and deletion. Measure a large local archive without full-conversation hydration on each page. |
| 1 | Ordinary Nostr interoperability. Contact messaging currently creates a KithMoot room; separate ordinary NIP-17 messaging is explicitly an unqualified candidate. | Ordinary NIP-17 DMs; application-specific edits and groups remain separate. | Qualify the existing candidate with an independent client in both directions, including external signer and inbox-relay behaviour. | Actual sender and recipient applications display the same authenticated text/reply after restart; preserve exact-envelope retries and keep private room material out of the ordinary lane. |
| 1 | Protection of ordinary local room secrets. External signers do not protect device keys, seal keys, retained epochs and admissions already stored by the browser. | Anagram uses native keychain storage for its account key, but browser keys and decrypted history remain exposed. It is not a stronger model in every respect. | Complete the existing protected-storage work, including desktop custody, coherent migration, failure recovery and forgetting. | Inventory the actual production writers; prove migration/restore and refusal without data loss or silent fallback. Do not equate browser non-extractability with protection against a copied profile or compromised running origin. |
| 2 | A coherent fresh-device recovery journey. Encrypted bookmarks, admission recovery and backups already exist in different components. | An explicit 12-word group-owner recovery flow and authenticated recovery records. | Explain and exercise what restores identity, room admission, ownership and history separately. Consider an independent encrypted backup without changing the key schedule by implication. | Fresh-device restore with the original device unavailable; distinguish missing ciphertext, lost ownership and ordinary member re-entry. Explain what each backup holder can read/control. |
| 2 | General agent interaction beyond approval cards. Existing approvals enforce principal/admin authority; assignments already have questions and exact-result review. | General callback/copy/link buttons, polls and personal card responses with version, expiry and retry checks. | Extend existing agent/work contracts with bounded typed interactions and readable fallback text. Ordinary menu navigation must not create execution authority or replace result acceptance. | Retry/deduplication, expired or edited cards, account changes, revoked membership, concurrent devices and clear shared versus personal results. Existing principal-only approval tests continue to hold. |
| 2 | Everyday notification acceptance. Native background listeners, conversation notifications and replies already exist; browser delivery and first-contact invitations have different limits. | Foreground Android listener, call actions, mute policy and explicit process/reboot limitations. | Finish G2 by qualifying the existing implementations, including first-contact delivery and rekey continuity. Do not build a duplicate listener. | Physical no-Play GrapheneOS: locked phone, Doze, reboot, network transition, removed room, duplicate suppression and measured battery use. State browser/iPhone limits separately. |
| 3 | Small conversation conveniences: message pins and deliberate forwarding. Room pinning is already present. | Owner-controlled message pins and a forwarding picker. | Assess demand before adding these; distinguish forwarding text from disclosing files, invitations or agent context. | Pin/edit/delete convergence, accessible mobile controls, deliberate destination selection and preservation of room/file disclosure rules. |

Sources and current implementation points:

- History: [Anagram group paging](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/docs/private-groups.md#history-paging),
  [large-history benchmark](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/e2e/dm-performance.spec.ts),
  [room archive](../app/src/room-archive.ts),
  [conversation search](../app/src/conversation-search.ts),
  [imported-history index](../app/src/history-index.ts).
- Interoperability: [Anagram DMs](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/docs/direct-messages.md),
  [KithMoot contact messaging](signet-contact-messaging.md),
  [ordinary-message candidate and qualification limits](ordinary-nostr-message.md).
- Storage/recovery: [our security model](security-model.md),
  [storage inventory](ordinary-storage-inventory.md),
  [account bookmarks](../app/src/room-bookmarks.ts),
  [Anagram recovery specification](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/nips/nip171.md#recovery-master-and-key-derivation).
- Agent interaction: [existing approvals](agents.md#approvals-in-the-room),
  [workspace delivery](workspace-delivery.md),
  [Anagram bot controls](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/docs/bot-keyboards.md).
- Notifications: native Android `docs/android-notifications.md` in its separate
  repository, and [Anagram notifications](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/docs/android-notifications.md).
- Conveniences: [Anagram public-group pins](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/docs/public-groups.md#pinned-message)
  and [forwarding picker](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/src/lib/components/ForwardMessagePicker.svelte).

## Security choices that are not ordinary feature gaps

Anagram's recovery master can derive all recorded epoch keys. Its specification
explicitly says compromise exposes recorded past and future epochs and provides
no forward secrecy against master compromise. This is an intelligible recovery
trade-off, not a stronger messaging guarantee to adopt without a decision.

Ordinary KithMoot rooms also make no forward-secrecy claim. The MLS development
preview is not production messaging. If forward secrecy is pursued, specify
device addition, offline delivery, lost-device restore, key erasure and the
authority of any history backup. Message-history restoration and live call
transport are separate questions; choosing Iroh answers neither history policy
nor stored-message forward secrecy.

## Capabilities to retain

Participant-grouped devices, encrypted file uploads, protected capture and
redaction, recording notices, scoped context, projects/Boards and the agent
assignment/acceptance lifecycle are valuable existing KithMoot capabilities.
Transport work should preserve those contracts. Anagram's unencrypted uploads
are not a direction for file sharing. Public-community discovery and a native
iOS client are product choices, not prerequisites to learning from its calls.

Implementation, release publication, automated checks and physical acceptance
remain separate. This review added documentation only and ran no media or
device qualification.
