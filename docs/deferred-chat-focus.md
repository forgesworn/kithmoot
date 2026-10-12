# Preserve a newer focus choice when opening call chat

Opening call chat moves focus into the message box on the next animation
frame. Previously that callback also ran after the person had already moved
to another control. It could take focus from the call/chat divider, sending
subsequent arrow keys into the message box instead of resizing the call.

The opener now remembers the active element. Its deferred callback focuses
the message box only while chat remains open and that element still has
focus. A newer focus choice is preserved. The usual automatic message-box
focus, disabled-input checks and panel visibility checks remain in place.

Three controls exercise the actual built application across a held frame:
choose the divider and resize with ArrowLeft; leave focus on the opener and
receive the usual input focus; close the panel and retain the chosen toolbar
control. The divider control fails before correction, while the other two
pass. The original drag, keyboard, clamp, remembered-width and full call
layout cases retain their assertions and deadlines.

The earlier hosted narrow-column failure includes 771 ArrowLeft actions in
its width loop. Its exact focus transition remains unproven; this controlled
callback defect is measured independently. Keep the original failure trace
and require the complete desktop acceptance suite and all final-head jobs
before merge or deployment.
