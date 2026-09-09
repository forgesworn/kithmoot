# Device credentials, per room and per person

A kind 20460 device credential is signed by the participant key and travels
only inside encryption. It says: this device may act for this participant
until this time.

## Room form

`d` = room id, `device` = device pubkey, `expiration` = Unix seconds. This is
what the roster has always carried. Unchanged.

## Person form

`d` = the participant's own pubkey, `scope` = `person`, optional `label`,
and `expiration` at most 30 days after `created_at`. One credential lets a
device act for the person in every room, DM and box that accepts the form.

```json
{"kind": 20460, "pubkey": "<participant>", "tags": [["d", "<participant>"], ["device", "<device>"], ["expiration", "1760000000"], ["scope", "person"], ["label", "phone"]], "content": ""}
```

## Verifying

`verifyDeviceCredential(cred, { roomId, now })` accepts a room credential
for that room, and a person credential only with `acceptPerson: true`, which
a room passes when admitting the person admits their devices.
`verifyDeviceCredential(cred, { identity, now })` accepts only a person
credential for that identity. A room credential carrying a `scope` tag is
refused; a person credential presented as a room credential without
`acceptPerson` is refused; a person credential longer than 30 days is
refused. Revocation is a kind 5 by the participant naming the credential's
id, carried inside encryption to every room and device.

## What a device never gets

The participant secret. A device holds its own key and a credential. It
cannot mint a room credential, because that is signed by the participant.
