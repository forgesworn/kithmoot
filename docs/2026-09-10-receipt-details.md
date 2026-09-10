# Receipt details during live updates

Hosted run `34426024021` passed Node 22/24, Firefox and WebKit. Chromium
passed the call-recovery repair and discovery, but its agent receipt test
expected explicit recipient keys before both signed roster entries had
arrived. The test now waits for both agents in the roster before checking
that compatibility expansion. Both agents were already acknowledging the
room-wide sentinel; those assertions remain.

Three local repetitions then exposed a separate interaction failure: the
open receipt popover vanished while the chat redrew. Replacing message rows
removes the top-layer popover, and automatic scrolling also dismissed it.
Rendering now restores the same message's open details with current content,
and scrolling repositions them while the anchor remains visible. Moving
away, Escape, leaving the visible log and changing conversation still close
the details.

The acceptance test sends another message while the two-agent receipt
details are open, then checks both names and received times without hovering
again. This expanded case failed after the initial redraw-only repair. With
scroll positioning included, both receipt tests passed three consecutive
Chromium runs (six tests). Hosted checks on the final candidate remain
required.
