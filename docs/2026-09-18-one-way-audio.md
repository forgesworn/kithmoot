# One-way audio with nothing injected

"I could see them but I could not hear them." The oldest complaint about this
app, reproduced at last by `test/call-stability.spec.ts` with no fault
injected at all: CI run `35320249730` failed the BASELINE of the
signalling-window case and of case 7b, before either of them touched
anything. Four people joined, and two of them could see the third and not
hear her while the fourth could hear her perfectly.

## What the evidence said

The dead direction printed `no-audio`: there was no `<audio>` element in that
person's tile at all, not a silent one. The pair's line in the app's own bug
report said the receiver was alive and the packets were arriving:

```
direct:4ff0e938:2 conn=connected ice=connected sig=stable
  send=[audio:live video:live] recv=[audio:live:muted video:live]
  in=[audio:pk4854,video:pk9523] out=[audio:pk4861,video:pk8978]
```

The report did not say which direction each transceiver had been negotiated
with, which is the fact the whole failure turns on, so it does now:
`recv=[audio:live:muted@0:sendonly video:live@1:sendrecv]`. With that line the
failure is legible at a glance - the m-line the audio is arriving on was
negotiated `sendonly`, so as far as this end is concerned it is not receiving
anything, while the far end's own report of the same m-line says `sendrecv`
and its outbound counter climbs.

## Why the two ends disagreed

Reproduced locally four times in eleven four-person joins, with the
descriptions read off both ends:

1. Ada offers. Her audio m-line is `a=sendrecv`.
2. Cara answers - but her microphone is a pipeline that takes a moment to
   start, and it has not reached that connection yet. So she answers
   honestly: `a=recvonly`. Ada applies it and settles at `sendonly`.
3. Cara's microphone arrives. `addTrack` widens her slot to `sendrecv` and
   the connection asks to renegotiate, so Cara offers.
4. Ada's ordinary offer retry lands in the middle of that. To Cara it is a
   collision, and as the polite side she rolls her own offer back and answers
   the same offer a second time - now saying `a=sendrecv`.
5. Ada is already `stable`. That second answer was dropped as a duplicate.

Nothing renegotiates afterwards, because from each end's own point of view
nothing has changed. Cara sends audio for the rest of the call and Ada's
transceiver says she is not receiving it. Chromium goes on counting the
packets, but the receiver's track stays muted and the app's tile mapping -
which asked the transceiver's `currentDirection` whether it was receiving -
gave it no slot, so no element was ever made for it. A track with no sink is
never decoded, which is why the measured audio energy was exactly zero.

## The repair

Three changes, in `src/peer.ts` and the app's tile mapping.

**A second, different answer to the same offer is a disagreement, not a
duplicate.** It cannot be applied - `setRemoteDescription` of an answer at
`stable` throws - so the offerer answers it with one ordinary renegotiation
from `stable`, which settles both ends on one description and touches neither
ICE nor DTLS. Only when we were the offerer of the completed exchange, and
only once per distinct answer, so a far end repeating a stale copy cannot
make this side offer once per copy.

**The answering side says so too.** A side that answers the same remote offer
twice, differently, knows the far end may have applied either, and offers
once from `stable` to settle it. This is what repairs the pair when the far
end is an older build with none of this in it.

**A tile follows the media, not the SDP.** `bindRoles` dropped any receiver
whose `currentDirection` did not say it was receiving. It now keeps one whose
inbound RTP is arriving whatever the direction says. The rule that filter
existed for is untouched: a sender the far end removed stops arriving, so a
stale receiver is still never progressing and still never takes a live slot.

The same session turned up a second failure of the same shape on the video
side - a picture parked for two quiet seconds under load never came back,
because a parked element's clock stops advancing and that clock was the only
way back. A picture whose packets are arriving is no longer parked, and one
that is parked comes back as soon as they arrive again.

## Profile 2

Not exposed. A profile-2 answerer widens all four slots to `sendrecv` in
`SlotSet.bind` before it answers, whether or not a track is attached to them,
and every later media change is a `replaceTrack` that changes no direction.
The `recvonly` answer this failure begins with cannot be written there, and
the profile's answers to a repeated offer carry the same directions every
time. The fixes above are on the legacy path, which is what is live.

## Reproducing it

`test/call-stability.spec.ts` keeps the case as
`four people join through one relay: every direction comes up, with nothing
injected` - four people, one relay, no fault. It failed 4 times in 11 runs
before the repair.
