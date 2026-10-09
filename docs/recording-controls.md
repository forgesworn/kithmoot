# Recording controls

The PWA records audio locally with the room creator's signed recording notice.
The notice is sent before recording starts. Other members and late joiners see
it; joining a recorded call requires the existing consent step.

The recorder sees captured elapsed time, pause/resume where the browser
supports it, and stop. These controls also appear in the original call's dock
while another room or the home page is open. They always operate on the
originating call. Only the recording device can pause or resume its recorder.

Paused intervals are omitted from the saved audio timeline. Elapsed time counts
captured time rather than wall time. The signed notice remains on throughout a
pause, including for late joiners: recording may resume, and another client
with the same authority could also be recording. This keeps older clients'
privacy warning intact without changing the wire protocol.

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
