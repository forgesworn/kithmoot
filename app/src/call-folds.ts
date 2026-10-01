/**
 * The call's extra settings, folded until somebody asks for them.
 *
 * Background blur, voice masking and the two-device switches sit under one
 * "More" fold in index.html - with, on a wide screen, the call's view and
 * the desktop window's other ways to share. Physical desktop acceptance
 * showed that opening the effect explanations by default pushed every face
 * and the conversation below the fold. The primary controls stay visible at
 * every size; settings open only after the person chooses More.
 */

const fold = document.getElementById('callExtras')
if (fold instanceof HTMLDetailsElement) fold.open = false
