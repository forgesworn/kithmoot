# Recording controls

Anyone on a group or private one-to-one call may record locally. Each recording
device signs its own complete notice, identifying the person, device, call and
capture layout. An exact relay acknowledgement precedes capture. Other members
and late joiners see the warning; joining a recorded call requires consent.

All devices on the call must support recording profile 4 before participant
recording is available. An idle older device does not block it. The room creator
can still use the older authority-signed notice in a normal room with older
call clients. Quiet rooms require the new live-presence warnings. Recording
grants no moderation or room ownership powers.

Simultaneous recordings have independent notices: stopping one does not stop
another or clear its warning. A call change, room closure, key change or loss
of warning compatibility stops capture. Failed stop publication leaves an
unconfirmed warning rather than claiming the remote warning was cleared.

The recorder sees captured elapsed time, pause/resume where the browser
supports it, and stop. These controls also appear in the original call's dock
while another room or the home page is open. They always operate on the
originating call. Only the recording device can pause or resume its recorder.

Paused intervals are omitted from the saved audio timeline. Elapsed time counts
captured time rather than wall time. The signed notice remains on throughout a
pause, including for late joiners: recording may resume, and another person
could also be recording.

On stop, the recorder waits for its final data event before creating the file,
including when a browser error or file-size limit stopped it automatically.
Save, deliberate encrypted sharing and discard retain their existing behaviour.
Room destruction discards a local unsaved recording, including one finalising;
it cannot delete independently saved or shared copies.

G11 remains open. This change provides audio controls, not gallery/speaker/
share-with-camera video recording or a supported 45-minute cross-client export
journey. Physical browser/device interruption, synchronisation, memory and
native Android acceptance remain required. Temporary-meeting retention rules
must also be made explicit before declaring the complete goal finished.
